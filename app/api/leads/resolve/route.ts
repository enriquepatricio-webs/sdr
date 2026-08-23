import { NextResponse } from "next/server";
import { and, asc, desc, eq, ne, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  TERMINAL_LEAD_STATUSES,
  accounts,
  campaigns,
  leads,
  touches,
} from "@/lib/db/schema";
import { jsonError, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Encuentra a quién pertenece un mensaje entrante, y devuelve el hilo completo.
 *
 * Se resuelve primero por `unipile_chat_id`, que identifica una conversación
 * concreta y es inequívoco. El `provider_id` es el respaldo, y ahí sí puede
 * haber ambigüedad: la misma persona puede estar en dos campañas. En ese caso
 * gana el lead ACTIVO más recientemente tocado, porque es el hilo en el que esa
 * persona está de verdad contestando.
 *
 * `account_id` (el de Unipile, el que recibió el mensaje) ACOTA esa ambigüedad a
 * la empresa dueña de esa cuenta, y hay que pasarlo siempre que se sepa. Sin él,
 * con dos empresas conectadas, una respuesta que entra por la cuenta del cliente
 * B puede resolverse contra el lead que el cliente A tiene de la misma persona:
 * a partir de ahí el agente contesta con el playbook, el contexto y las
 * lecciones de A en una conversación que existe en la cuenta de B. Es el peor
 * fallo posible del sistema y no da ningún error.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const chatId = url.searchParams.get("chat_id");
  const providerId = url.searchParams.get("provider_id");
  const accountId = url.searchParams.get("account_id");

  if (!chatId && !providerId) {
    return jsonError("Hace falta chat_id o provider_id.");
  }

  try {
    let lead: typeof leads.$inferSelect | undefined;

    if (chatId) {
      const [porChat] = await db
        .select({ lead: leads })
        .from(touches)
        .innerJoin(leads, eq(touches.leadId, leads.id))
        // Se excluyen los terminales aquí también: si alguien pidió la baja y
        // vuelve a escribir en el mismo hilo, el agente no tiene que despertarse.
        .where(
          and(
            eq(touches.unipileChatId, chatId),
            notInArray(leads.status, [...TERMINAL_LEAD_STATUSES]),
          ),
        )
        .orderBy(desc(touches.createdAt))
        .limit(1);
      lead = porChat?.lead;
    }

    if (!lead && providerId) {
      // La empresa dueña de la cuenta por la que ha entrado el mensaje. Si no
      // se sabe cuál es, se busca en todas y se acepta la ambigüedad, que es lo
      // que había antes; con account_id, no.
      const empresa = accountId
        ? ((
            await db
              .select({ id: accounts.workspaceId })
              .from(accounts)
              .where(eq(accounts.unipileAccountId, accountId))
          )[0]?.id ?? null)
        : null;

      const candidatos = await db
        .select({ lead: leads })
        .from(leads)
        .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
        .where(
          and(
            eq(leads.providerId, providerId),
            notInArray(leads.status, [...TERMINAL_LEAD_STATUSES]),
            ...(empresa ? [eq(campaigns.workspaceId, empresa)] : []),
          ),
        )
        .orderBy(desc(leads.updatedAt))
        .limit(2);

      // Dos empresas distintas reclaman a la misma persona y no hay forma de
      // saber cuál. Antes se elegía la más reciente en silencio; ahora no se
      // elige: que lo mire un humano es mucho más barato que escribirle al
      // prospecto de un cliente desde la cuenta de otro.
      if (candidatos.length > 1 && !empresa) {
        return NextResponse.json(
          {
            encontrado: false,
            ambiguo: true,
            motivo:
              "Esa persona está en campañas de más de una empresa y el mensaje no dice por qué cuenta ha entrado. Pasa account_id.",
          },
          { status: 409 },
        );
      }
      lead = candidatos[0]?.lead;
    }

    if (!lead) {
      return NextResponse.json(
        {
          encontrado: false,
          // Un mensaje de alguien a quien no hemos escrito nosotros. No es un
          // error: puede ser tráfico normal de la cuenta.
          motivo: "No hay ningún lead activo con ese chat_id ni provider_id.",
        },
        { status: 404 },
      );
    }

    const [campana] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, lead.campaignId));
    const hilo = await db
      .select({
        direction: touches.direction,
        body: touches.body,
        status: touches.status,
        createdAt: touches.createdAt,
      })
      .from(touches)
      .where(and(eq(touches.leadId, lead.id), ne(touches.status, "borrador")))
      .orderBy(asc(touches.createdAt))
      .limit(40);

    return NextResponse.json({
      encontrado: true,
      lead,
      campana,
      chatId: chatId ?? null,
      /** Congelado por un humano: el agente no debe responder. */
      congelado: lead.status === "revision_humana",
      hilo: hilo.map((t) => ({
        quien: t.direction === "out" ? "nosotros" : "prospecto",
        texto: t.body,
        cuando: t.createdAt,
      })),
    });
  } catch (err) {
    return serverError(err, "No se pudo resolver el lead");
  }
}
