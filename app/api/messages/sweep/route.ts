import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  TERMINAL_LEAD_STATUSES,
  accounts,
  campaigns,
  leads,
  normalizedEmail,
  touches,
} from "@/lib/db/schema";
import { jsonError, serverError } from "@/lib/api";
import { listarCorreos, listarMensajes } from "@/lib/unipile";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Red de seguridad de las respuestas entrantes.
 *
 * El agente solo se entera de que alguien ha contestado por un webhook de
 * Unipile, y ese webhook es un único punto de fallo silencioso: estuvo días sin
 * entregar nada y el sistema siguió pareciendo sano — prospectando, enviando y
 * sumando en el panel — mientras las respuestas se quedaban sin contestar. En
 * la base de datos no había NI UN toque entrante en todo el histórico.
 *
 * Esto pregunta activamente por lo que ya ocurrió, en vez de esperar a que
 * alguien nos lo cuente. Con el webhook sano no hace nada, porque todo lo que
 * encuentra ya está registrado; con el webhook roto, el sistema sigue
 * contestando con un retraso de minutos en vez de no contestar nunca.
 *
 * No responde por su cuenta: reinyecta lo que encuentra en el mismo webhook de
 * n8n, para que la conversación pase exactamente por donde pasa siempre — el
 * mismo agente, el mismo playbook, la misma deduplicación. Un segundo camino
 * hasta el prospecto sería un segundo sitio donde olvidarse de comprobar si el
 * lead pidió la baja.
 */

/**
 * Cuántas respuestas se reinyectan por vuelta.
 *
 * El cron pasa cada pocos minutos, así que un atasco se drena solo. El tope
 * está para que un buzón con cien respuestas viejas no dispare cien agentes a
 * la vez, que es justo lo que hay que evitar: cien mensajes saliendo en el
 * mismo segundo se parecen mucho a un bot.
 */
const MAX_POR_VUELTA = 5;

/** Hasta dónde mira hacia atrás en el buzón la primera vez. */
const DIAS_DE_CORREO = 14;

/**
 * Tope de hilos que se miran por vuelta.
 *
 * Cada hilo es una llamada a Unipile, así que el coste crece con las
 * conversaciones abiertas y no con el trabajo que hay que hacer. Con el cron
 * cuarto-horario, cien hilos por vuelta cubren de sobra el ritmo actual.
 *
 * ponytail: recorta a los cien hilos tocados más recientemente; si algún día
 * hay más de cien conversaciones vivas a la vez, hace falta guardar por dónde
 * iba el barrido en vez de empezar siempre por arriba.
 */
const MAX_HILOS_POR_VUELTA = 100;

type Entrante = {
  accountId: string;
  messageId: string;
  chatId: string | null;
  texto: string;
  email: string | null;
  nombre: string | null;
  providerId: string | null;
  cuando: string | null;
};

export async function POST() {
  const webhook = process.env.N8N_INBOUND_WEBHOOK_URL;
  if (!webhook) {
    return jsonError(
      "Falta N8N_INBOUND_WEBHOOK_URL. Sin ella no hay dónde reinyectar las respuestas.",
      500,
    );
  }

  try {
    const candidatos = [
      ...(await deLasConversaciones()),
      ...(await delCorreo()),
    ];

    const nuevos = await soloLosNoRegistrados(candidatos);
    const aReinyectar = nuevos.slice(0, MAX_POR_VUELTA);

    const reinyectados: string[] = [];
    const fallidos: { messageId: string; error: string }[] = [];
    for (const e of aReinyectar) {
      try {
        const res = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(comoWebhookDeUnipile(e)),
        });
        if (!res.ok) throw new Error(`n8n respondió ${res.status}`);
        reinyectados.push(e.messageId);
      } catch (err) {
        fallidos.push({
          messageId: e.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return NextResponse.json({
      revisados: candidatos.length,
      sinContestar: nuevos.length,
      reinyectados,
      fallidos,
      pendientes: Math.max(0, nuevos.length - aReinyectar.length),
    });
  } catch (err) {
    return serverError(err, "No se pudo barrer la bandeja de entrada");
  }
}

/**
 * Lo que nos han escrito en los hilos de LinkedIn e Instagram.
 *
 * Se parte de NUESTROS hilos, no de la lista de conversaciones de la cuenta: lo
 * que interesa son las respuestas de gente a la que escribimos nosotros, y así
 * el coste es proporcional a las campañas abiertas y no al buzón entero.
 */
async function deLasConversaciones(): Promise<Entrante[]> {
  const hilos = await db
    .selectDistinct({
      chatId: touches.unipileChatId,
      unipileAccountId: accounts.unipileAccountId,
      // Va en el SELECT porque Postgres exige que lo que ordena un DISTINCT
      // esté también entre las columnas seleccionadas.
      tocadoEn: leads.updatedAt,
    })
    .from(touches)
    .innerJoin(leads, eq(touches.leadId, leads.id))
    .innerJoin(accounts, eq(touches.accountId, accounts.id))
    .where(
      and(
        isNotNull(touches.unipileChatId),
        eq(accounts.status, "active"),
        notInArray(leads.status, [...TERMINAL_LEAD_STATUSES]),
      ),
    )
    .orderBy(desc(leads.updatedAt))
    .limit(MAX_HILOS_POR_VUELTA);

  const encontrados: Entrante[] = [];
  for (const hilo of hilos) {
    if (!hilo.chatId) continue;
    try {
      const { items } = await listarMensajes(hilo.chatId, 20);
      for (const m of items ?? []) {
        // `is_sender` llega como 0/1 o como booleano según el proveedor. Lo que
        // no puede pasar es tratar un mensaje nuestro como entrante: el agente
        // se contestaría a sí mismo en bucle.
        if (m.is_sender) continue;
        if (!m.text?.trim()) continue;
        encontrados.push({
          accountId: hilo.unipileAccountId,
          messageId: m.id,
          chatId: hilo.chatId,
          texto: m.text,
          email: null,
          nombre: null,
          providerId: m.sender_id ?? null,
          cuando: m.timestamp ?? null,
        });
      }
    } catch {
      // Un hilo que Unipile ya no sirve (chat borrado, cuenta reconectada) no
      // puede dejar sin revisar a los demás.
      continue;
    }
  }
  return encontrados;
}

/**
 * Lo que nos han contestado por correo.
 *
 * El correo no tiene hilo que guardar — al enviar no se crea ninguna
 * conversación en Unipile — así que aquí se va al revés: se lee el buzón y se
 * cruza con las direcciones a las que hemos escrito. Sin ese cruce se
 * reinyectaría también cada boletín y cada aviso automático que entra.
 */
async function delCorreo(): Promise<Entrante[]> {
  const buzones = await db
    .select({
      unipileAccountId: accounts.unipileAccountId,
      workspaceId: accounts.workspaceId,
    })
    .from(accounts)
    .where(and(eq(accounts.provider, "email"), eq(accounts.status, "active")));

  const desde = new Date(Date.now() - DIAS_DE_CORREO * 24 * 60 * 60 * 1000);
  const encontrados: Entrante[] = [];

  for (const buzon of buzones) {
    let items;
    try {
      ({ items } = await listarCorreos({
        accountId: buzon.unipileAccountId,
        desde,
      }));
    } catch {
      continue;
    }

    const recibidos = (items ?? []).filter(
      (c) => c.from_attendee?.identifier && (c.body_plain ?? "").trim(),
    );
    if (recibidos.length === 0) continue;

    const direcciones = [
      ...new Set(
        recibidos.map((c) => c.from_attendee!.identifier!.toLowerCase()),
      ),
    ];

    // Solo las direcciones que son un lead vivo de ESTA empresa. Lo demás que
    // haya en el buzón no es asunto del agente.
    const nuestras = new Set(
      (
        await db
          .select({ email: leads.email })
          .from(leads)
          .innerJoin(campaigns, eq(campaigns.id, leads.campaignId))
          .where(
            and(
              inArray(normalizedEmail(leads.email), direcciones),
              notInArray(leads.status, [...TERMINAL_LEAD_STATUSES]),
              ...(buzon.workspaceId
                ? [eq(campaigns.workspaceId, buzon.workspaceId)]
                : []),
            ),
          )
      )
        .map((l) => l.email?.toLowerCase())
        .filter((e): e is string => Boolean(e)),
    );

    for (const c of recibidos) {
      const de = c.from_attendee!.identifier!.toLowerCase();
      if (!nuestras.has(de)) continue;
      encontrados.push({
        accountId: buzon.unipileAccountId,
        messageId: c.id,
        chatId: null,
        texto: (c.body_plain ?? "").trim(),
        email: de,
        nombre: c.from_attendee?.display_name ?? null,
        providerId: null,
        cuando: c.date ?? null,
      });
    }
  }
  return encontrados;
}

/**
 * Quita lo que el agente ya vio.
 *
 * La prueba de que un mensaje está atendido es que existe su toque entrante:
 * lo escribe el propio flujo de n8n al recibirlo, así que si está, la
 * conversación siguió su curso.
 */
async function soloLosNoRegistrados(lista: Entrante[]): Promise<Entrante[]> {
  if (lista.length === 0) return [];
  const ids = [...new Set(lista.map((e) => e.messageId))];
  const yaEstan = new Set(
    (
      await db
        .select({ id: touches.unipileMessageId })
        .from(touches)
        .where(inArray(touches.unipileMessageId, ids))
    )
      .map((t) => t.id)
      .filter((id): id is string => Boolean(id)),
  );

  const vistos = new Set<string>();
  return lista.filter((e) => {
    if (yaEstan.has(e.messageId) || vistos.has(e.messageId)) return false;
    vistos.add(e.messageId);
    return true;
  });
}

/**
 * El mismo sobre que manda Unipile, para que n8n no sepa de dónde viene.
 *
 * Se reutiliza la forma del webhook de mensajería incluso para el correo, con
 * `email` como campo extra: así hay UN solo nodo que interpreta entrantes en
 * vez de dos que se desincronizan.
 */
function comoWebhookDeUnipile(e: Entrante) {
  return {
    event: "message_received",
    account_id: e.accountId,
    chat_id: e.chatId,
    message_id: e.messageId,
    message: e.texto,
    email: e.email,
    is_sender: false,
    timestamp: e.cuando,
    sender: {
      attendee_provider_id: e.providerId,
      attendee_name: e.nombre,
    },
    attendees: [],
    /** Marca de dónde salió, para poder distinguirlo en las ejecuciones. */
    origen: "barrido",
  };
}
