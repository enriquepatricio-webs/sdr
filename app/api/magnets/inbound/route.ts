import { NextResponse } from "next/server";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { accounts, leadMagnets, magnetContacts } from "@/lib/db/schema";
import { jsonError, parseBody, serverError } from "@/lib/api";
import { ejecutarCiclo } from "@/lib/magnets";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Alguien ha contestado en una conversación que lleva un imán: avanzarlo YA.
 *
 * El cron de cada cuarto de hora sirve para descubrir comentarios nuevos, pero
 * no para esto. Quien acaba de escribir "ya está" está delante de la pantalla
 * esperando un recurso que le hemos prometido "ahora mismo", y hacerle esperar
 * al siguiente cuarto de hora es exactamente la diferencia entre un embudo que
 * parece vivo y uno que parece roto.
 *
 * Lo llama n8n desde el mismo webhook de mensajes entrantes, en el sitio donde
 * antes se ignoraba la conversación por ser de un imán.
 *
 * No duplica nada de la lógica del ciclo: ejecuta el ciclo del imán dueño de
 * esa conversación. La máquina de estados, el cupo, la ventana de envío y la
 * comprobación de baja son las mismas de siempre, y así no hay dos caminos
 * distintos hacia la misma persona.
 */
const cuerpo = z
  .object({
    chatId: z.string().min(1).optional(),
    leadId: z.string().uuid().optional(),
  })
  .refine((d) => d.chatId || d.leadId, {
    message: "Hace falta chatId o leadId.",
  });

export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo);
  if (!body.ok) return body.response;
  const d = body.data;

  try {
    /**
     * Solo los estados en los que el imán todavía tiene algo que hacer. En
     * `entregado` y `en_conversacion` la conversación ya es del agente, y
     * despertar el ciclo desde aquí sería pisarle el turno.
     */
    const [fila] = await db
      .select({ iman: leadMagnets, cuenta: accounts, contacto: magnetContacts })
      .from(magnetContacts)
      .innerJoin(leadMagnets, eq(leadMagnets.id, magnetContacts.magnetId))
      .innerJoin(accounts, eq(accounts.id, leadMagnets.accountId))
      .where(
        and(
          or(
            d.chatId ? eq(magnetContacts.unipileChatId, d.chatId) : undefined,
            d.leadId ? eq(magnetContacts.leadId, d.leadId) : undefined,
          ),
          inArray(magnetContacts.state, [
            "detectado",
            "pidiendo_follow",
            "verificado",
          ]),
        ),
      )
      .limit(1);

    if (!fila) {
      // No es un error: la mayoría de los mensajes entrantes no son de un imán.
      return NextResponse.json({ deUnIman: false });
    }
    if (!fila.iman.active || fila.cuenta.status !== "active") {
      return jsonError("Ese imán o su cuenta están parados.", 409);
    }

    return NextResponse.json({
      deUnIman: true,
      iman: fila.iman.name,
      usuario: fila.contacto.username,
      resumen: await ejecutarCiclo(fila.iman, fila.cuenta),
    });
  } catch (err) {
    return serverError(err, "No se pudo avanzar el imán");
  }
}
