/**
 * Imanes de Instagram: "comenta LA PALABRA y te mando el recurso".
 *
 * El embudo entero es una máquina de estados de cinco pasos y no se salta
 * ninguno: se detecta a quien comenta, se le pide que siga ANTES de darle nada,
 * se comprueba que sigue, se le manda el recurso y se le propone una llamada.
 *
 * Lo que decide algo está en funciones puras (detección de la palabra,
 * transiciones, petición de que le dejen en paz) para poder probarlo sin red ni
 * base de datos: son las tres cosas que, si fallan, le escriben a quien no toca.
 */
import { and, count, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { MENCIONA_DINERO } from "./sin-precios";
import { MINUTOS_QUE_RESERVA_UN_BORRADOR, calcularCupo } from "./quota";
import { ajustesEfectivos } from "./workspace";
import { fueraDeVentana } from "./sending-window";
import {
  TERMINAL_LEAD_STATUSES,
  accounts,
  campaigns,
  followers,
  leadMagnets,
  magnetContacts,
  magnetStateEnum,
  leads,
  runLogs,
  touches,
} from "./db/schema";
import { ACTORES_LECTURA, runSync } from "./apify";
import {
  enviarEnChat,
  iniciarChat,
  listarMensajes,
  obtenerUsuario,
} from "./unipile";

export type EstadoIman = (typeof magnetStateEnum.enumValues)[number];

/* -------------------------------------------------------------------------- */
/* Máquina de estados                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Las únicas transiciones que existen. Están AQUÍ y no repartidas por el
 * código: si la regla "no se entrega a quien no se ha verificado" vive en tres
 * `if` distintos, tarde o temprano uno de los tres se olvida.
 *
 * `descartado` es terminal y se alcanza desde cualquier sitio: cuando alguien
 * pide que le dejen en paz no hay más pasos que dar, ni siquiera una despedida.
 */
export const TRANSICIONES = {
  detectado: ["pidiendo_follow", "descartado"],
  pidiendo_follow: ["verificado", "descartado"],
  verificado: ["entregado", "descartado"],
  entregado: ["en_conversacion", "descartado"],
  en_conversacion: ["descartado"],
  descartado: [],
} as const satisfies Record<EstadoIman, readonly EstadoIman[]>;

export function puedeTransicionar(
  desde: EstadoIman,
  hasta: EstadoIman,
): boolean {
  return (TRANSICIONES[desde] as readonly EstadoIman[]).includes(hasta);
}

/**
 * Qué toque es cada paso. Sirve para no mandar dos veces el mismo mensaje: si
 * ya hay un toque con ese `step` para ese lead, ese paso está hecho (o esperando
 * aprobación con el autopiloto apagado).
 */
export const PASO_DE_ESTADO = {
  detectado: 1,
  verificado: 2,
  entregado: 3,
} as const satisfies Partial<Record<EstadoIman, number>>;

/* -------------------------------------------------------------------------- */
/* Texto                                                                       */
/* -------------------------------------------------------------------------- */

/** Minúsculas y sin acentos: "GUÍA", "guia" y "Guía" son la misma palabra. */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Sin arroba, sin espacios y en minúsculas. Es la forma canónica de un usuario. */
export function normalizarUsuario(usuario: string): string {
  return usuario.trim().replace(/^@+/, "").trim().toLowerCase();
}

function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Si un comentario contiene la palabra clave.
 *
 * Tolerante a que vaya dentro de una frase, con emojis o con signos pegados,
 * pero NO a que sea parte de otra palabra: con la clave "guia", "guiado" no
 * cuenta. Quien comenta otra cosa no ha pedido nada y no se le escribe.
 */
export function mencionaClave(texto: string, clave: string): boolean {
  const c = normalizar(clave).trim();
  if (!c) return false;
  const borde = "[^\\p{L}\\p{N}]";
  return new RegExp(`(?:^|${borde})${escapar(c)}(?:${borde}|$)`, "u").test(
    normalizar(texto),
  );
}

/**
 * Alguien pidiendo que le dejen en paz. Se prefiere parar de más.
 *
 * En cuanto esto da positivo el contacto pasa a `descartado` y no recibe nada
 * más, ni una despedida: contestar a un "no me escribas" es escribirle.
 */
const PIDE_QUE_LE_DEJEN =
  /(no me (escrib|habl|mand|contest|molest|llam)|dej[ae]\w* en paz|dejame tranquil|no me interesa|no quiero nada|para de escribir|no insistas|es spam|denunci|unsubscribe|\bstop\b)/i;

export function pideQueLeDejen(texto: string): boolean {
  return PIDE_QUE_LE_DEJEN.test(normalizar(texto));
}

/**
 * Lo que se manda después del recurso para intentar la reunión.
 *
 * Es constante y no un ajuste porque el usuario pidió menos cosas que tocar, y
 * porque a partir de aquí la conversación la lleva el agente: esto solo abre la
 * puerta. Sin cifras, por la misma razón que el resto del sistema.
 */
export const PITCH_REUNION =
  "Por cierto, si te viene bien, te cuento en 15 minutos cómo lo aplicamos nosotros a un caso como el tuyo. ¿Te va bien esta semana o la que viene?";

/* -------------------------------------------------------------------------- */
/* Comentarios                                                                 */
/* -------------------------------------------------------------------------- */

/** Lo que devuelve el actor de comentarios, quedándonos con lo que usamos. */
type ComentarioApify = {
  id?: string;
  text?: string;
  ownerUsername?: string;
  owner?: { id?: string; username?: string; full_name?: string };
};

export type ComentarioClave = {
  username: string;
  fullName: string | null;
  commentId: string | null;
};

/**
 * Los comentarios que contienen la palabra, uno por persona.
 *
 * Deduplicar aquí no sustituye al índice único de la base de datos: es que en
 * Instagram la misma persona comenta la palabra tres veces seguidas cuando no
 * le contestas al minuto, y sin esto se generarían tres inserciones que la base
 * rechazaría una por una.
 */
export function comentariosConLaClave(
  items: ComentarioApify[],
  clave: string,
): ComentarioClave[] {
  const vistos = new Set<string>();
  const salida: ComentarioClave[] = [];

  for (const c of items) {
    const bruto = c.ownerUsername ?? c.owner?.username;
    if (!bruto || !mencionaClave(c.text ?? "", clave)) continue;
    const username = normalizarUsuario(bruto);
    if (!username || vistos.has(username)) continue;
    vistos.add(username);
    salida.push({
      username,
      fullName: c.owner?.full_name?.trim() || null,
      commentId: c.id ?? null,
    });
  }
  return salida;
}

/** Lee los comentarios de la publicación y se queda con los que piden el recurso. */
export async function leerComentarios(
  postUrl: string,
  clave: string,
  limite = 200,
): Promise<ComentarioClave[]> {
  const items = await runSync<ComentarioApify>(
    ACTORES_LECTURA.comentariosInstagram,
    { directUrls: [postUrl], resultsLimit: limite },
    { maxItems: limite, timeoutSecs: 120 },
  );
  return comentariosConLaClave(items, clave);
}

/* -------------------------------------------------------------------------- */
/* Seguidores                                                                  */
/* -------------------------------------------------------------------------- */

/** Cuánto vale la caché de seguidores antes de volver a scrapear. */
/**
 * Cada refresco es una ejecución de pago de Apify que baja cientos de
 * seguidores. Cada media hora, 24/7 y por cuenta, son cientos de miles de
 * registros al mes para responder a una pregunta —¿me sigue esta persona?— que
 * casi nunca cambia de un rato para otro. Seis horas es de sobra, y además solo
 * se refresca cuando hay alguien esperando verificación.
 */
export const SEGUIDORES_FRESCOS_MIN = 360;

/**
 * Cuántos seguidores se traen en cada refresco.
 *
 * El actor los devuelve empezando por los más recientes, que es exactamente a
 * quien buscamos: alguien que acaba de seguir para recibir el recurso.
 * ponytail: si una cuenta grande recibe muchos seguidores por hora, subir esto.
 */
export const SEGUIDORES_POR_REFRESCO = 500;

/**
 * Frescura exigida cuando alguien ha CONTESTADO al "dale a seguir".
 *
 * Seis horas es un ahorro sensato para preguntar por gente que no ha dicho
 * nada. Pero quien acaba de escribir "Ya está" está delante de la pantalla
 * esperando un recurso que le hemos prometido "ahora mismo", y una caché de
 * hasta seis horas convierte esa promesa en mentira. Ese mensaje es la señal
 * más barata que hay de que merece la pena pagar el scraping.
 */
export const SEGUIDORES_FRESCOS_SI_CONTESTAN_MIN = 10;

/**
 * Cuántas veces se pide el follow, contando la primera.
 *
 * Dos: la petición y un recordatorio. A la tercera ya no es un recordatorio,
 * es insistir.
 */
export const MAX_PETICIONES_DE_FOLLOW = 2;

/** Paso del recordatorio. Aparte de los tres del embudo para no pisarlos. */
export const PASO_RECORDATORIO = 4;

/**
 * Lo que se responde a quien dice que ya sigue y no aparece en la lista.
 *
 * Callarse es lo que hacía antes, y desde el otro lado es indistinguible de un
 * bot roto: la persona contesta, no pasa nada, y se va.
 */
export const RECORDATORIO_FOLLOW =
  "Gracias, pero todavía no me sale que me sigas. Dale a seguir y te lo mando al momento; si ya le has dado, dame un minuto y vuelve a escribirme.";

/**
 * Cada cuánto se vuelve a leer la publicación buscando comentarios nuevos.
 *
 * El cron pasa cada 15 minutos, pero releer el post entero cada vez es pagar
 * por lo mismo noventa y seis veces al día: un imán vivo un mes son cientos de
 * miles de resultados de Apify para encontrar los pocos comentarios que hay.
 * Una hora es más que suficiente para un lead magnet, y entre lectura y lectura
 * el ciclo sigue haciendo avanzar a quien ya está en la cola.
 */
export const COMENTARIOS_CADA_MIN = 60;

type SeguidorApify = { username?: string; full_name?: string };

/** El nombre de usuario de Instagram de la cuenta, tal como lo dio Unipile. */
async function usuarioDeCuenta(
  accountId: string,
): Promise<{ unipileAccountId: string; usuario: string }> {
  const [cuenta] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!cuenta) throw new Error("Esa cuenta no existe.");
  if (cuenta.provider !== "instagram")
    throw new Error("Esa cuenta no es de Instagram.");
  if (!cuenta.instagramUsername?.trim()) {
    // Antes se usaba `displayName`, que es una etiqueta de interfaz editable.
    // Con un nombre que no fuese el handle, el actor devolvía cero seguidores,
    // nadie se verificaba nunca y se relanzaba el scraping de pago sin fin.
    // Fallar aquí es incómodo una vez; lo otro es caro y silencioso siempre.
    throw new Error(
      `La cuenta "${cuenta.displayName}" no tiene guardado su @usuario de Instagram. Ponlo en Ajustes → La empresa para que se pueda comprobar quién te sigue.`,
    );
  }
  return {
    unipileAccountId: cuenta.unipileAccountId,
    usuario: normalizarUsuario(cuenta.instagramUsername),
  };
}

/**
 * Vuelve a leer MI lista de seguidores y la cachea.
 *
 * Una ejecución para toda la cuenta, no una por contacto. Comprobar el
 * "following" de cada persona multiplicaría el coste y el riesgo de bloqueo por
 * cada comentario, y el imán existe precisamente para tener muchos.
 */
export async function refrescarSeguidores(accountId: string): Promise<number> {
  const { usuario } = await usuarioDeCuenta(accountId);

  const items = await runSync<SeguidorApify>(
    ACTORES_LECTURA.seguidoresInstagram,
    {
      usernames: [usuario],
      dataToScrape: "followers",
      resultsLimit: SEGUIDORES_POR_REFRESCO,
    },
    { maxItems: SEGUIDORES_POR_REFRESCO, timeoutSecs: 240 },
  );

  const filas = items
    .map((s) => normalizarUsuario(s.username ?? ""))
    .filter(Boolean)
    .map((username) => ({ accountId, username, seenAt: new Date() }));

  if (!filas.length) return 0;

  // Solo se añade y se refresca la fecha. No se borra a quien ya no aparece: el
  // scraping viene acotado, y borrar por ausencia convertiría un lote corto en
  // "toda tu gente ha dejado de seguirte".
  // ponytail: quien deja de seguir sigue contando como seguidor. Para caducarlo
  // de verdad haría falta un barrido completo de la lista.
  await db
    .insert(followers)
    .values(filas)
    .onConflictDoUpdate({
      target: [followers.accountId, followers.username],
      set: { seenAt: sql`excluded.seen_at` },
    });

  return filas.length;
}

/** Cuándo se refrescó por última vez la caché de esta cuenta. */
/**
 * Refresca la lista de seguidores como mucho una vez por ciclo, y solo si está
 * vieja. Devuelve cuántos hay cacheados.
 */
export async function refrescarSiHaceFalta(
  accountId: string,
  frescuraMin: number = SEGUIDORES_FRESCOS_MIN,
): Promise<number> {
  const visto = await seguidoresVistosEn(accountId);
  if (visto && Date.now() - visto.getTime() <= frescuraMin * 60_000) return -1;
  return refrescarSeguidores(accountId);
}

export async function seguidoresVistosEn(
  accountId: string,
): Promise<Date | null> {
  const [fila] = await db
    .select({ seenAt: followers.seenAt })
    .from(followers)
    .where(eq(followers.accountId, accountId))
    .orderBy(desc(followers.seenAt))
    .limit(1);
  return fila?.seenAt ?? null;
}

/**
 * Si esa persona sigue a la cuenta. Refresca la caché si está vieja.
 *
 * El refresco es de la cuenta entera, así que la primera comprobación de una
 * tanda paga el scraping y las demás salen gratis.
 */
/**
 * Solo LEE la caché. Refrescarla es cosa de `refrescarSiHaceFalta`, que corre
 * una vez por ciclo.
 *
 * Antes refrescaba aquí si la caché estaba vieja, y como un scrapeo que
 * devuelve cero no escribe nada, la caché seguía "vieja" para siempre: se
 * relanzaba el actor de pago UNA VEZ POR CONTACTO, en cada ciclo, sin fin. Con
 * 50 contactos cada cuarto de hora son 200 ejecuciones a la hora.
 */
export async function verificarSigue(
  accountId: string,
  username: string,
): Promise<boolean> {
  const [fila] = await db
    .select({ username: followers.username })
    .from(followers)
    .where(
      and(
        eq(followers.accountId, accountId),
        eq(followers.username, normalizarUsuario(username)),
      ),
    );
  return Boolean(fila);
}

/* -------------------------------------------------------------------------- */
/* Envío                                                                       */
/* -------------------------------------------------------------------------- */

export type Iman = typeof leadMagnets.$inferSelect;
export type Contacto = typeof magnetContacts.$inferSelect;
export type Cuenta = typeof accounts.$inferSelect;

/**
 * La campaña donde viven los leads de este imán.
 *
 * Hace falta una porque `touches.lead_id` no admite nulos: un mensaje sin lead
 * no se puede registrar, y sin registro no se puede enviar. Se crea en
 * `draft` y propia del imán, nunca se reutiliza una que esté corriendo: si los
 * leads del imán cayeran en una campaña activa, el agente normal les escribiría
 * su primer toque además del DM del imán, y la persona recibiría dos mensajes.
 *
 * Que esté en borrador NO corta la conversación. Cuando la persona contesta al
 * DM, el webhook entra por W2, que resuelve el lead por chat_id contra
 * /api/leads/resolve — y ahí el estado de la campaña no se mira. A partir de esa
 * respuesta el agente lleva la conversación, cualifica y agenda como con
 * cualquier otro lead. Lo único que el borrador impide es que W1 y W3 le
 * escriban en frío por su cuenta, que es exactamente lo que se busca.
 *
 * Por eso esta campaña no se pone en marcha: activarla es el error, no el
 * arreglo. Tampoco necesita playbook propio; /api/playbook/active resuelve el de
 * la empresa a partir del campaign_id.
 */
export async function campanaDelIman(iman: Iman): Promise<string> {
  const nombre = `Imán: ${iman.name}`;
  const [existente] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.workspaceId, iman.workspaceId),
        eq(campaigns.name, nombre),
      ),
    );
  if (existente) return existente.id;

  const [nueva] = await db
    .insert(campaigns)
    .values({
      name: nombre,
      status: "draft",
      workspaceId: iman.workspaceId,
      accountId: iman.accountId,
      channel: "instagram",
      sendingWindow: {
        tz: "Europe/Madrid",
        from: "09:00",
        to: "21:00",
        days: [1, 2, 3, 4, 5, 6, 7],
      },
    })
    .returning({ id: campaigns.id });
  return nueva.id;
}

/**
 * El lead de un contacto, creándolo la primera vez.
 *
 * Resolver el usuario contra Unipile es lo que convierte "@ana" en algo a lo
 * que se puede escribir. Si Unipile no lo encuentra (cuenta borrada, privada o
 * el nombre cambiado) se devuelve null y el contacto se queda donde está.
 */
export async function asegurarLead(
  iman: Iman,
  contacto: Contacto,
  cuenta: Cuenta,
): Promise<{ leadId: string; providerId: string } | null> {
  if (contacto.leadId && contacto.providerId) {
    return { leadId: contacto.leadId, providerId: contacto.providerId };
  }

  const perfil = await obtenerUsuario(
    cuenta.unipileAccountId,
    contacto.username,
  );
  const providerId = perfil.provider_id ?? perfil.id ?? null;
  if (!providerId) return null;

  const campaignId = await campanaDelIman(iman);
  const nombre = contacto.fullName || perfil.name || contacto.username;

  const [creado] = await db
    .insert(leads)
    .values({
      campaignId,
      fullName: nombre,
      instagramUsername: contacto.username,
      providerId,
      status: "nuevo",
    })
    // El índice único por (campaña, usuario normalizado) es el que impide que
    // dos ejecuciones creen dos leads para la misma persona.
    .onConflictDoNothing()
    .returning({ id: leads.id });

  const leadId =
    creado?.id ??
    (
      await db
        .select({ id: leads.id })
        .from(leads)
        .where(
          and(
            eq(leads.campaignId, campaignId),
            eq(leads.instagramUsername, contacto.username),
          ),
        )
    )[0]?.id;

  if (!leadId) return null;

  await db
    .update(magnetContacts)
    .set({ leadId, providerId })
    .where(eq(magnetContacts.id, contacto.id));

  return { leadId, providerId };
}

/**
 * El toque de ese paso del imán, si ya existe.
 *
 * Es lo que impide mandar dos veces el mismo mensaje, y además resuelve el caso
 * del borrador aprobado a mano: si el toque ya está `enviado`, el paso está
 * hecho aunque no lo enviara el ciclo, y el contacto tiene que avanzar igual.
 */
export async function toqueDelPaso(
  leadId: string,
  paso: number,
): Promise<{
  status: "borrador" | "enviado" | "fallido";
  unipileChatId: string | null;
} | null> {
  const [fila] = await db
    .select({ status: touches.status, unipileChatId: touches.unipileChatId })
    .from(touches)
    .where(
      and(
        eq(touches.leadId, leadId),
        eq(touches.step, paso),
        eq(touches.direction, "out"),
      ),
    )
    .orderBy(desc(touches.createdAt))
    .limit(1);
  return fila ?? null;
}

export type ResultadoEnvio = {
  enviado: boolean;
  motivo?: "menciona_dinero" | "autopiloto_apagado" | "fallo" | "lead_cerrado";
  chatId?: string | null;
};

/**
 * Manda un DM replicando la secuencia de `app/api/messages/send/route.ts`:
 * registrar → enviar → confirmar, y si el envío falla NO se reintenta.
 *
 * No se llama a esa ruta por HTTP a propósito: sería que el despliegue se pida
 * a sí mismo, con su propia autenticación y con la protección de Vercel por
 * delante. Lo que no se puede cambiar es el orden, y el orden es este.
 */
export async function enviarDm(opciones: {
  leadId: string;
  cuenta: Cuenta;
  providerId: string;
  chatId: string | null;
  texto: string;
  paso: number;
  autopilot: boolean;
}): Promise<ResultadoEnvio> {
  const { leadId, cuenta, texto, paso } = opciones;

  /**
   * Un lead cerrado no recibe nada, tampoco por aquí.
   *
   * El imán no pasa por `/api/messages/send`, así que la comprobación que hay
   * allí —la que impide escribir a quien pidió la baja— no le cubría. Entre
   * "entregado" y el pitch de reunión hay una ventana en la que el agente puede
   * haber cerrado el lead como `no_interesado`, y el pitch salía igual.
   */
  const [lead] = await db
    .select({ status: leads.status })
    .from(leads)
    .where(eq(leads.id, leadId));
  if (
    lead &&
    (TERMINAL_LEAD_STATUSES as readonly string[]).includes(lead.status)
  ) {
    await db.insert(runLogs).values({
      workflow: "iman",
      leadId,
      level: "info",
      message: `El imán no escribe: el lead está en "${lead.status}".`,
      payload: { paso },
    });
    return { enviado: false, motivo: "lead_cerrado" };
  }

  if (MENCIONA_DINERO.test(texto)) {
    await db.insert(runLogs).values({
      workflow: "iman",
      leadId,
      level: "warn",
      message: "Mensaje del imán bloqueado: mencionaba dinero.",
      payload: { texto },
    });
    return { enviado: false, motivo: "menciona_dinero" };
  }

  // ---- 1. Registrar ANTES de enviar ---------------------------------------
  const [toque] = await db
    .insert(touches)
    .values({
      leadId,
      accountId: cuenta.id,
      channel: "instagram",
      direction: "out",
      status: "borrador",
      body: texto,
      unipileChatId: opciones.chatId,
      step: paso,
    })
    .returning({ id: touches.id });

  // ---- Autopiloto apagado: aquí se para -----------------------------------
  if (!opciones.autopilot) {
    await db.insert(runLogs).values({
      workflow: "iman",
      leadId,
      level: "info",
      message:
        "Borrador del imán guardado. El autopiloto está apagado, no se ha enviado nada.",
      payload: { touchId: toque.id, paso },
    });
    return { enviado: false, motivo: "autopiloto_apagado" };
  }

  // ---- 2. Enviar -----------------------------------------------------------
  try {
    let chatId = opciones.chatId;
    let messageId: string;
    if (chatId) {
      messageId = (await enviarEnChat(chatId, texto)).message_id;
    } else {
      const r = await iniciarChat({
        accountId: cuenta.unipileAccountId,
        attendeeId: opciones.providerId,
        texto,
      });
      messageId = r.message_id;
      chatId = r.chat_id;
    }

    // ---- 3. Confirmar ------------------------------------------------------
    await db
      .update(touches)
      .set({
        status: "enviado",
        sentAt: new Date(),
        unipileMessageId: messageId,
        unipileChatId: chatId,
      })
      .where(eq(touches.id, toque.id));

    await db
      .update(leads)
      .set({ status: "contactado", touchCount: sql`${leads.touchCount} + 1` })
      .where(eq(leads.id, leadId));

    return { enviado: true, chatId };
  } catch (err) {
    // Queda en 'fallido' y nadie lo reintenta: el envío pudo salir y haber
    // fallado solo la respuesta, y reintentar duplicaría el mensaje.
    await db
      .update(touches)
      .set({ status: "fallido" })
      .where(eq(touches.id, toque.id));
    await db.insert(runLogs).values({
      workflow: "iman",
      leadId,
      level: "error",
      message: `Falló el DM del imán: ${err instanceof Error ? err.message : String(err)}`,
      payload: { touchId: toque.id, noSeReintenta: true },
    });
    return { enviado: false, motivo: "fallo" };
  }
}

/* -------------------------------------------------------------------------- */
/* Cupo                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Lo que ha salido por esta cuenta en las últimas 24 h y en los últimos 60 min.
 *
 * Ventanas deslizantes en vez de día y hora naturales: no hacen falta zonas
 * horarias y son más restrictivas justo donde importa, porque no dejan una
 * ráfaga a las 23:59 y otra a las 00:01.
 */
export async function enviosRecientes(
  accountId: string,
): Promise<{ dia: number; hora: number }> {
  const ahora = Date.now();
  const desdeDia = new Date(ahora - 24 * 60 * 60_000);
  const desdeHora = new Date(ahora - 60 * 60_000);

  const desdeReserva = new Date(
    ahora - MINUTOS_QUE_RESERVA_UN_BORRADOR * 60_000,
  );

  // Un borrador recién escrito cuenta como enviado: es la reserva que impide
  // que la campaña en frío y el imán se gasten el mismo hueco a la vez.
  const reservado = sql`(${touches.status} = 'borrador' and ${touches.createdAt} >= ${desdeReserva})`;
  const enviadoDia = sql`(${touches.status} = 'enviado' and ${touches.sentAt} >= ${desdeDia})`;
  const enviadoHora = sql`(${touches.status} = 'enviado' and ${touches.sentAt} >= ${desdeHora})`;

  const [fila] = await db
    .select({
      dia: sql<number>`count(*)::int`,
      hora: sql<number>`count(*) filter (where ${enviadoHora} or ${reservado})::int`,
    })
    .from(touches)
    .where(
      and(
        eq(touches.accountId, accountId),
        eq(touches.direction, "out"),
        sql`(${enviadoDia} or ${reservado})`,
      ),
    );

  return { dia: Number(fila?.dia ?? 0), hora: Number(fila?.hora ?? 0) };
}

/* -------------------------------------------------------------------------- */
/* Respuestas entrantes                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Si en el hilo hay alguien pidiendo que le dejen en paz.
 *
 * Se mira ANTES de cada mensaje que no sea el primero. Es la única forma de
 * respetar esa petición sin depender de que el webhook de Unipile esté
 * conectado, y cuesta una llamada por contacto al que se iba a escribir.
 */
export async function pidioQueLeDejen(chatId: string): Promise<boolean> {
  const { items } = await listarMensajes(chatId, 20);
  return items.some((m) => !m.is_sender && m.text && pideQueLeDejen(m.text));
}

/* -------------------------------------------------------------------------- */
/* Contactos                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Da de alta a quien ha comentado la palabra. Devuelve cuántos son nuevos.
 *
 * `onConflictDoNothing` sobre (magnetId, username) es lo que hace que ejecutar
 * el ciclo dos veces seguidas no genere dos contactos ni dos mensajes.
 */
export async function registrarComentarios(
  magnetId: string,
  comentarios: ComentarioClave[],
): Promise<number> {
  if (!comentarios.length) return 0;
  const creados = await db
    .insert(magnetContacts)
    .values(
      comentarios.map((c) => ({
        magnetId,
        username: c.username,
        fullName: c.fullName,
        commentId: c.commentId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: magnetContacts.id });
  return creados.length;
}

/** Cambia el estado solo si la transición es legal y nadie se ha adelantado. */
export async function moverA(
  contacto: Contacto,
  hasta: EstadoIman,
  extra: Partial<typeof magnetContacts.$inferInsert> = {},
): Promise<boolean> {
  if (!puedeTransicionar(contacto.state, hasta)) return false;
  const filas = await db
    .update(magnetContacts)
    .set({ state: hasta, ...extra })
    .where(
      and(
        eq(magnetContacts.id, contacto.id),
        eq(magnetContacts.state, contacto.state),
      ),
    )
    .returning({ id: magnetContacts.id });
  return filas.length > 0;
}

/**
 * Si ese contacto ha escrito DESPUÉS de que le pidiéramos el follow.
 *
 * Es la señal de "creo que ya he hecho lo que me pediste". Sirve para dos
 * cosas: pagar un refresco de seguidores que merece la pena, y saber a quién
 * hay que contestarle si resulta que todavía no aparece en la lista.
 */
export async function contestoDespuesDePedirle(
  contacto: Contacto,
): Promise<boolean> {
  if (!contacto.leadId) return false;
  const [fila] = await db
    .select({ id: touches.id })
    .from(touches)
    .where(
      and(
        eq(touches.leadId, contacto.leadId),
        eq(touches.direction, "in"),
        gt(touches.createdAt, contacto.updatedAt),
      ),
    )
    .limit(1);
  return Boolean(fila);
}

/** Los contactos que todavía tienen algo pendiente, los más antiguos primero. */
export async function contactosPendientes(
  magnetId: string,
  limite: number,
): Promise<Contacto[]> {
  return db
    .select()
    .from(magnetContacts)
    .where(
      and(
        eq(magnetContacts.magnetId, magnetId),
        inArray(magnetContacts.state, [
          "detectado",
          "pidiendo_follow",
          "verificado",
          "entregado",
        ]),
      ),
    )
    .orderBy(magnetContacts.createdAt)
    .limit(limite);
}

/**
 * ¿Ya se le ha escrito hoy a esta persona desde esta cuenta?
 *
 * En Instagram el hilo con alguien es único. Si la misma persona comenta en dos
 * publicaciones con imán, o está además en la campaña en frío de la misma
 * cuenta, acabaría recibiendo dos secuencias completas EN EL MISMO CHAT: seis
 * mensajes, y el pitch de reunión dos veces palabra por palabra, porque es una
 * constante.
 *
 * La comprobación es por `providerId` —la persona— y por cuenta, no por lead,
 * que es justo lo que no dedupe: cada campaña tiene su propia fila de lead para
 * la misma persona.
 */
export async function yaEscritoHoy(
  accountId: string,
  providerId: string,
): Promise<boolean> {
  const desde = new Date(Date.now() - 24 * 60 * 60_000);
  const [fila] = await db
    .select({ n: count() })
    .from(touches)
    .innerJoin(leads, eq(leads.id, touches.leadId))
    .where(
      and(
        eq(touches.accountId, accountId),
        eq(touches.direction, "out"),
        eq(leads.providerId, providerId),
        gte(touches.createdAt, desde),
      ),
    );
  return Number(fila?.n ?? 0) > 0;
}

/* -------------------------------------------------------------------------- */
/* El ciclo                                                                    */
/* -------------------------------------------------------------------------- */

/** Cuántos contactos se miran por ciclo. El cupo horario recorta muy por debajo. */
const LOTE = 50;

/** Fallos seguidos antes de descartar un contacto y dejar de intentarlo. */
const MAX_INTENTOS = 3;

export type ResumenCiclo = {
  comentariosConLaClave: number;
  contactosNuevos: number;
  peticionesDeFollow: number;
  verificados: number;
  entregados: number;
  enConversacion: number;
  descartados: number;
  borradores: number;
  sinCupo: { motivo: string; detalle?: string } | null;
};

/**
 * Un ciclo del imán: leer comentarios nuevos y hacer avanzar un paso a quien
 * toque.
 *
 * Es seguro llamarla dos veces seguidas. Tres cosas lo garantizan y ninguna
 * depende de la otra:
 *   · el índice único (magnetId, username) hace que un comentario repetido no
 *     genere un contacto nuevo;
 *   · antes de escribir se comprueba que no exista ya un toque de ese paso para
 *     ese lead, así que un segundo ciclo no repite el mensaje;
 *   · el cambio de estado es condicional al estado anterior.
 *
 * ponytail: eso cubre llamadas seguidas, no dos ciclos EN PARALELO sobre el
 * mismo imán. Si algún día se lanza desde dos sitios a la vez hace falta un
 * bloqueo por imán (un `select ... for update` sobre la fila del imán basta).
 */
export async function ejecutarCiclo(
  iman: Iman,
  cuenta: Cuenta,
): Promise<ResumenCiclo> {
  /**
   * Un solo ciclo a la vez por imán.
   *
   * Llamadas SEGUIDAS ya eran seguras, pero dos ciclos EN PARALELO no: el botón
   * del panel y el cron de cada cuarto de hora pueden coincidir, y entre el
   * `toqueDelPaso` que comprueba y el `enviarDm` que escribe hay una ventana en
   * la que los dos creen que el paso sigue pendiente. El resultado es el mismo
   * DM dos veces a la misma persona.
   *
   * `last_checked_at` hace de arrendamiento: solo entra quien consigue moverlo,
   * y como el UPDATE es condicional esa carrera la gana uno solo. Si el ciclo se
   * cae a mitad, el arrendamiento caduca en cinco minutos.
   */
  const [turno] = await db
    .update(leadMagnets)
    .set({ lastCheckedAt: new Date() })
    .where(
      and(
        eq(leadMagnets.id, iman.id),
        sql`(${leadMagnets.lastCheckedAt} is null or ${leadMagnets.lastCheckedAt} < now() - interval '5 minutes')`,
      ),
    )
    .returning({ id: leadMagnets.id });

  if (!turno) {
    return {
      comentariosConLaClave: 0,
      contactosNuevos: 0,
      peticionesDeFollow: 0,
      verificados: 0,
      entregados: 0,
      enConversacion: 0,
      descartados: 0,
      borradores: 0,
      sinCupo: {
        motivo: "ya_en_marcha",
        detalle: "Otro ciclo de este imán sigue corriendo.",
      },
    };
  }

  const ajustes = await ajustesEfectivos(iman.workspaceId);

  /* ---- 1. Comentarios nuevos, como mucho una vez por hora -------------- */
  const tocaLeer =
    !iman.comentariosLeidosAt ||
    Date.now() - iman.comentariosLeidosAt.getTime() >
      COMENTARIOS_CADA_MIN * 60_000;

  let comentarios: ComentarioClave[] = [];
  let nuevos = 0;
  if (tocaLeer) {
    comentarios = await leerComentarios(iman.postUrl, iman.keyword);
    nuevos = await registrarComentarios(iman.id, comentarios);
    await db
      .update(leadMagnets)
      .set({ comentariosLeidosAt: new Date() })
      .where(eq(leadMagnets.id, iman.id));
  }

  /* ---- 1 bis. Seguidores: solo si hay alguien esperando verificación ---- */
  // Refrescar por refrescar es pagar un scraping para responder a una pregunta
  // que nadie ha hecho.
  const [{ n: esperando } = { n: 0 }] = await db
    .select({ n: count() })
    .from(magnetContacts)
    .where(
      and(
        eq(magnetContacts.magnetId, iman.id),
        eq(magnetContacts.state, "pidiendo_follow"),
      ),
    );

  if (Number(esperando) > 0) {
    /**
     * Si alguno de los que esperan ha contestado, la caché tiene que estar
     * fresca de verdad: esa persona está delante de la pantalla esperando lo
     * que le hemos prometido "ahora mismo".
     */
    const enEspera = await db
      .select()
      .from(magnetContacts)
      .where(
        and(
          eq(magnetContacts.magnetId, iman.id),
          eq(magnetContacts.state, "pidiendo_follow"),
        ),
      );
    let alguienContesto = false;
    for (const c of enEspera) {
      if (await contestoDespuesDePedirle(c)) {
        alguienContesto = true;
        break;
      }
    }

    const cacheados = await refrescarSiHaceFalta(
      cuenta.id,
      alguienContesto
        ? SEGUIDORES_FRESCOS_SI_CONTESTAN_MIN
        : SEGUIDORES_FRESCOS_MIN,
    );
    if (cacheados === 0) {
      await db.insert(runLogs).values({
        workflow: "iman",
        level: "warn",
        message: `No se pudo leer la lista de seguidores de "${cuenta.displayName}". Nadie pasará de "pidiendo_follow" hasta que se lea.`,
        payload: { magnetId: iman.id, accountId: cuenta.id },
      });
    }
  }

  /* ---- 2. Cuánto se puede escribir ------------------------------------ */
  const enviados = await enviosRecientes(cuenta.id);
  const cupo = calcularCupo({
    topeDiarioCuenta: cuenta.dailyLimit,
    // Un imán no tiene tope propio: el de la cuenta es el que manda, y en
    // Instagram el que de verdad frena es el horario (8/h por defecto).
    topeDiarioCampana: cuenta.dailyLimit,
    topeHorarioCuenta: cuenta.hourlyLimit,
    enviadosHoyCuenta: enviados.dia,
    enviadosHoyCampana: enviados.dia,
    enviadosEstaHoraCuenta: enviados.hora,
    lote: LOTE,
  });

  let presupuesto = cupo.hay ? cupo.cuantos : 0;
  const resumen = {
    comentariosConLaClave: comentarios.length,
    contactosNuevos: nuevos,
    peticionesDeFollow: 0,
    verificados: 0,
    entregados: 0,
    enConversacion: 0,
    descartados: 0,
    borradores: 0,
    sinCupo: cupo.hay ? null : { motivo: cupo.motivo, detalle: cupo.detalle },
  };

  /* ---- 2 bis. La ventana de envío también vale para el imán ------------ */
  // Sin esto el cron manda DMs a las cuatro de la mañana y en fin de semana:
  // solo miraba el cupo, que no sabe nada de horas decentes.
  const [campana] = await db
    .select({ ventana: campaigns.sendingWindow })
    .from(campaigns)
    .where(eq(campaigns.id, await campanaDelIman(iman)));

  const fuera = campana ? fueraDeVentana(campana.ventana, new Date()) : null;
  if (fuera) {
    return {
      ...resumen,
      sinCupo: { motivo: "fuera_de_ventana", detalle: fuera },
    };
  }

  /* ---- 3. Avanzar a cada uno un paso ---------------------------------- */
  for (const contacto of await contactosPendientes(iman.id, LOTE)) {
    try {
      // Si en algún momento pidió que le dejaran en paz, se para aquí y no
      // recibe nada más, ni una despedida.
      //
      // Va ANTES de la rama de `pidiendo_follow`: estaba después, y como esa
      // rama termina siempre en `continue`, a quien decía "no me escribas"
      // mientras esperaba el follow no se le hacía ni caso.
      if (
        contacto.unipileChatId &&
        (await pidioQueLeDejen(contacto.unipileChatId))
      ) {
        if (await moverA(contacto, "descartado")) {
          resumen.descartados++;
          // Y el LEAD también: si solo se marca el contacto, el agente de
          // conversaciones entrantes sigue viendo un lead activo y le contesta al
          // que acaba de pedir que le dejen en paz.
          if (contacto.leadId) {
            await db
              .update(leads)
              .set({ status: "no_interesado", nextActionAt: null })
              .where(eq(leads.id, contacto.leadId));
          }
        }
        continue;
      }

      // Pasar de `pidiendo_follow` a `verificado` no manda nada, así que se hace
      // aunque no quede cupo: es lo que deja la cola lista para la hora siguiente.
      if (contacto.state === "pidiendo_follow") {
        if (await verificarSigue(cuenta.id, contacto.username)) {
          if (await moverA(contacto, "verificado", { verifiedAt: new Date() }))
            resumen.verificados++;
          continue;
        }

        /**
         * No sigue. Si ha contestado, hay que decírselo.
         *
         * Antes esto era un `continue` a secas y quien escribía "Ya está" sin
         * haber seguido se quedaba en silencio para siempre. Desde el otro lado
         * eso es indistinguible de un bot roto.
         */
        if (
          presupuesto > 0 &&
          contacto.leadId &&
          contacto.providerId &&
          contacto.followAsks < MAX_PETICIONES_DE_FOLLOW &&
          (await contestoDespuesDePedirle(contacto))
        ) {
          presupuesto--;
          const aviso = await enviarDm({
            leadId: contacto.leadId,
            cuenta,
            providerId: contacto.providerId,
            chatId: contacto.unipileChatId,
            texto: RECORDATORIO_FOLLOW,
            paso: PASO_RECORDATORIO,
            autopilot: ajustes.autopilot,
          });
          if (aviso.enviado) {
            await db
              .update(magnetContacts)
              .set({ followAsks: contacto.followAsks + 1 })
              .where(eq(magnetContacts.id, contacto.id));
            resumen.peticionesDeFollow++;
          } else if (aviso.motivo === "autopiloto_apagado") {
            resumen.borradores++;
          }
        }
        continue;
      }

      if (presupuesto <= 0) continue;
      if (contacto.state === "entregado" && !iman.pitchMeeting) continue;

      const identidad = await asegurarLead(iman, contacto, cuenta);
      if (identidad && (await yaEscritoHoy(cuenta.id, identidad.providerId))) {
        // Esta persona ya ha recibido algo por esta cuenta hoy: otro imán sobre
        // otro post, o la campaña en frío de la misma cuenta. En Instagram el
        // hilo es único, así que sería el mismo chat recibiendo dos secuencias.
        continue;
      }
      if (!identidad) {
        await db.insert(runLogs).values({
          workflow: "iman",
          level: "warn",
          message: `No se pudo resolver @${contacto.username} en Instagram. Se queda en "${contacto.state}".`,
          payload: { magnetId: iman.id, contactId: contacto.id },
        });
        continue;
      }

      const paso =
        PASO_DE_ESTADO[contacto.state as keyof typeof PASO_DE_ESTADO];
      const yaHecho = await toqueDelPaso(identidad.leadId, paso);

      // Un borrador sin aprobar (autopiloto apagado) o un envío que falló se
      // quedan como están: repetir cualquiera de los dos duplicaría el mensaje.
      if (yaHecho && yaHecho.status !== "enviado") continue;

      let envio: { enviado: boolean; motivo?: string; chatId?: string | null };
      if (yaHecho) {
        // El mensaje salió (lo aprobó una persona en la bandeja de borradores).
        // El paso está hecho aunque no lo enviara este ciclo, así que avanza.
        envio = { enviado: true, chatId: yaHecho.unipileChatId };
      } else {
        const texto =
          contacto.state === "detectado"
            ? iman.followMessage
            : contacto.state === "verificado"
              ? iman.resource
              : PITCH_REUNION;

        presupuesto--;
        envio = await enviarDm({
          leadId: identidad.leadId,
          cuenta,
          providerId: identidad.providerId,
          chatId: contacto.unipileChatId,
          texto,
          paso,
          autopilot: ajustes.autopilot,
        });
      }

      if (!envio.enviado) {
        if (envio.motivo === "autopiloto_apagado") resumen.borradores++;
        continue;
      }

      const chat = { unipileChatId: envio.chatId ?? contacto.unipileChatId };
      if (contacto.state === "detectado") {
        if (
          await moverA(contacto, "pidiendo_follow", {
            ...chat,
            followAsks: contacto.followAsks + 1,
          })
        ) {
          resumen.peticionesDeFollow++;
        }
      } else if (contacto.state === "verificado") {
        if (
          await moverA(contacto, "entregado", {
            ...chat,
            deliveredAt: new Date(),
          })
        ) {
          resumen.entregados++;
        }
      } else if (await moverA(contacto, "en_conversacion", chat)) {
        resumen.enConversacion++;
      }
    } catch (err) {
      /**
       * Un contacto que revienta no puede llevarse el ciclo por delante.
       *
       * `contactosPendientes` ordena por antigüedad, así que un usuario
       * irresoluble —cuenta borrada, handle cambiado, chat que ya no existe—
       * salía el primero, lanzaba la excepción y abortaba la vuelta entera.
       * Cada quince minutos, para siempre, y nadie detrás de él recibía nada.
       */
      const detalle = err instanceof Error ? err.message : String(err);
      const intentos = contacto.intentos + 1;
      const rendirse = intentos >= MAX_INTENTOS;

      await db
        .update(magnetContacts)
        .set({
          intentos,
          ...(rendirse ? { state: "descartado" as const } : {}),
        })
        .where(eq(magnetContacts.id, contacto.id));

      await db.insert(runLogs).values({
        workflow: "iman",
        level: rendirse ? "error" : "warn",
        message: rendirse
          ? `@${contacto.username} ha fallado ${intentos} veces y se descarta: ${detalle}`
          : `@${contacto.username} falló (intento ${intentos}): ${detalle}`,
        payload: { magnetId: iman.id, contactId: contacto.id },
      });
      if (rendirse) resumen.descartados++;
    }
  }

  await db.insert(runLogs).values({
    workflow: "iman",
    level: "info",
    message: `Ciclo del imán "${iman.name}": ${resumen.contactosNuevos} nuevos, ${resumen.entregados} entregados.`,
    payload: { magnetId: iman.id, ...resumen },
  });
  return resumen;
}
