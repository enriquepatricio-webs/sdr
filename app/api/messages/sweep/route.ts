import { NextResponse } from "next/server";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  TERMINAL_LEAD_STATUSES,
  accounts,
  campaigns,
  leads,
  normalizedEmail,
  runLogs,
  touches,
} from "@/lib/db/schema";
import { jsonError, serverError } from "@/lib/api";
import {
  asistentesDelChat,
  listarCorreos,
  listarMensajesDeCuenta,
} from "@/lib/unipile";

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
 * El cron pasa cada cuarto de hora, así que un atasco se drena solo. El tope
 * está para que un buzón con cien respuestas viejas no dispare cien agentes a
 * la vez, que es justo lo que hay que evitar: cien mensajes saliendo en el
 * mismo segundo se parecen mucho a un bot.
 */
const MAX_POR_VUELTA = 5;

/** Hasta dónde mira hacia atrás. */
const DIAS_ATRAS = 14;

/** Etiqueta con la que se apunta cada mensaje ya mirado. */
const YA_MIRADO = "barrido-visto";

type Entrante = {
  accountId: string;
  messageId: string;
  chatId: string | null;
  texto: string;
  email: string | null;
  nombre: string | null;
  providerId: string | null;
  usuario: string | null;
  cuando: string | null;
};

/** Algo que no se pudo leer. Se llama Fallo y no Error para no tapar el global. */
type Fallo = { donde: string; error: string };

export async function POST() {
  const webhook = process.env.N8N_INBOUND_WEBHOOK_URL;
  if (!webhook) {
    return jsonError(
      "Falta N8N_INBOUND_WEBHOOK_URL. Sin ella no hay dónde reinyectar las respuestas.",
      500,
    );
  }

  try {
    /**
     * Lo que no se pudo mirar.
     *
     * Un buzón que responde 400 y un buzón sin respuestas nuevas se ven
     * exactamente igual desde fuera: cero. Sin esta lista, la primera vez que
     * Unipile cambiara un parámetro el barrido seguiría diciendo que todo está
     * en orden mientras deja de leer el correo entero.
     */
    const errores: Fallo[] = [];
    const desde = new Date(Date.now() - DIAS_ATRAS * 24 * 60 * 60 * 1000);
    const cuentas = await db
      .select({
        unipileAccountId: accounts.unipileAccountId,
        provider: accounts.provider,
        workspaceId: accounts.workspaceId,
      })
      .from(accounts)
      .where(eq(accounts.status, "active"));

    const candidatos = [
      ...(await deLosMensajes(
        cuentas.filter((c) => c.provider !== "email"),
        desde,
        errores,
      )),
      ...(await delCorreo(
        cuentas.filter((c) => c.provider === "email"),
        desde,
        errores,
      )),
    ];

    const nuevos = await soloLosNoMirados(candidatos);
    const aReinyectar = nuevos.slice(0, MAX_POR_VUELTA);

    const reinyectados: string[] = [];
    const fallidos: { messageId: string; error: string }[] = [];
    for (const e of aReinyectar) {
      try {
        // El @usuario solo se pide de los que se van a reinyectar de verdad:
        // es una llamada más por hilo y no vale la pena gastarla en un mensaje
        // que se va a quedar esperando al siguiente cuarto de hora.
        const conUsuario = e.chatId ? await conElUsuarioDelHilo(e) : e;
        const res = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(comoWebhookDeUnipile(conUsuario)),
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

    await apuntarComoMirados(reinyectados);

    return NextResponse.json({
      revisados: candidatos.length,
      sinMirar: nuevos.length,
      reinyectados,
      fallidos,
      errores,
      pendientes: Math.max(0, nuevos.length - aReinyectar.length),
    });
  } catch (err) {
    return serverError(err, "No se pudo barrer la bandeja de entrada");
  }
}

/**
 * Lo que nos han escrito por LinkedIn e Instagram.
 *
 * Va cuenta a cuenta y no hilo a hilo a propósito. El `chat_id` que guardamos
 * al abrir una conversación NO se puede volver a leer: los veintisiete que
 * había en la base respondían 404 "Chat not found". Unipile da un identificador
 * al crear el chat y otro cuando la conversación existe de verdad.
 */
async function deLosMensajes(
  cuentas: { unipileAccountId: string }[],
  desde: Date,
  errores: Fallo[],
): Promise<Entrante[]> {
  const encontrados: Entrante[] = [];

  for (const cuenta of cuentas) {
    let items;
    try {
      ({ items } = await listarMensajesDeCuenta({
        accountId: cuenta.unipileAccountId,
        desde,
      }));
    } catch (err) {
      errores.push({
        donde: `cuenta ${cuenta.unipileAccountId}`,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const m of items ?? []) {
      // `is_sender` llega como 0/1 o como booleano según el proveedor. Lo que
      // no puede pasar es tratar un mensaje nuestro como entrante: el agente
      // se contestaría a sí mismo en bucle.
      if (m.is_sender) continue;
      if (!m.text?.trim()) continue;
      encontrados.push({
        accountId: cuenta.unipileAccountId,
        messageId: m.id,
        chatId: m.chat_id ?? null,
        texto: m.text,
        email: null,
        nombre: null,
        providerId: m.sender_id ?? null,
        usuario: null,
        cuando: m.timestamp ?? null,
      });
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
async function delCorreo(
  buzones: { unipileAccountId: string; workspaceId: string | null }[],
  desde: Date,
  errores: Fallo[],
): Promise<Entrante[]> {
  const encontrados: Entrante[] = [];

  for (const buzon of buzones) {
    let items;
    try {
      ({ items } = await listarCorreos({
        accountId: buzon.unipileAccountId,
        desde,
      }));
    } catch (err) {
      errores.push({
        donde: `buzón ${buzon.unipileAccountId}`,
        error: err instanceof Error ? err.message : String(err),
      });
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
        usuario: null,
        cuando: c.date ?? null,
      });
    }
  }
  return encontrados;
}

/**
 * Le pone al mensaje el @usuario de quien escribe.
 *
 * Es la única clave con la que se puede saber de quién es un DM. El `sender_id`
 * que trae Unipile no es el `provider_id` que guardamos nosotros: los de
 * Instagram salen de Google Maps y son códigos de sitio (`ChIJ...`).
 *
 * Si la llamada falla se sigue adelante sin él: quizá resuelva por chat_id, y
 * si no, W2 lo dará por tráfico ajeno, que es lo mismo que pasaría de todas
 * formas.
 */
async function conElUsuarioDelHilo(e: Entrante): Promise<Entrante> {
  try {
    const asistentes = await asistentesDelChat(e.chatId!);
    const otro = asistentes.find((a) => !a.is_self);
    if (!otro) return e;
    return {
      ...e,
      usuario: otro.specifics?.public_identifier ?? null,
      nombre: otro.name ?? e.nombre,
      providerId: otro.provider_id ?? e.providerId,
    };
  } catch {
    return e;
  }
}

/**
 * Quita lo que ya se miró.
 *
 * Dos pruebas, y hacen falta las dos. Que exista el toque entrante significa
 * que el agente lo atendió. Y el apunte en el registro significa que el barrido
 * ya lo mandó, aunque no fuera de nadie: sin eso, un mensaje de un desconocido
 * —que nunca llega a ser un toque— volvería a salir elegido en cada vuelta y
 * taparía para siempre a las respuestas de verdad que van detrás.
 */
async function soloLosNoMirados(lista: Entrante[]): Promise<Entrante[]> {
  if (lista.length === 0) return [];
  const ids = [...new Set(lista.map((e) => e.messageId))];

  const registrados = new Set(
    (
      await db
        .select({ id: touches.unipileMessageId })
        .from(touches)
        .where(inArray(touches.unipileMessageId, ids))
    )
      .map((t) => t.id)
      .filter((id): id is string => Boolean(id)),
  );

  const mirados = new Set(
    (
      await db
        .select({ id: sql<string>`${runLogs.payload}->>'messageId'` })
        .from(runLogs)
        .where(
          and(
            eq(runLogs.workflow, YA_MIRADO),
            inArray(sql`${runLogs.payload}->>'messageId'`, ids),
          ),
        )
    )
      .map((r) => r.id)
      .filter(Boolean),
  );

  const vistos = new Set<string>();
  return lista.filter((e) => {
    if (registrados.has(e.messageId) || mirados.has(e.messageId)) return false;
    if (vistos.has(e.messageId)) return false;
    vistos.add(e.messageId);
    return true;
  });
}

async function apuntarComoMirados(messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  await db.insert(runLogs).values(
    messageIds.map((messageId) => ({
      workflow: YA_MIRADO,
      level: "info" as const,
      message: `Reinyectado en el flujo de entrantes: ${messageId}`,
      payload: { messageId },
    })),
  );
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
      attendee_specifics: e.usuario ? { public_identifier: e.usuario } : {},
    },
    attendees: [],
    /** Marca de dónde salió, para poder distinguirlo en las ejecuciones. */
    origen: "barrido",
  };
}
