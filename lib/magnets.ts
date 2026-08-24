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
import { chat } from "./openrouter";
import { promptDeCampana } from "./playbook";
import { enviarEnConversacion, obtenerUsuario } from "./unipile";

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
 * Lo que se manda si el agente no puede redactar el "¿qué tal?".
 *
 * Es el respaldo, no el plan: mandar el mismo texto a todo el mundo un rato
 * después de entregar el recurso se nota, y lo que se pidió es que parezca una
 * persona. Sin cifras, por la misma razón que el resto del sistema.
 */
export const PITCH_REUNION =
  "Oye, ¿le has podido echar un ojo? Si quieres te cuento en quince minutos cómo lo aplicamos a un caso como el tuyo. ¿Te viene bien esta semana?";

/**
 * Cuánto se espera desde que se entrega el recurso hasta preguntar qué tal.
 *
 * Preguntar "¿qué te ha parecido?" dos minutos después de mandar algo delata a
 * un robot: no le ha dado tiempo a nadie a abrirlo. Entre cuarenta minutos y
 * dos horas es lo que tardaría una persona en acordarse.
 */
export const NUDGE_MIN_MINUTOS = 40;
export const NUDGE_MAX_MINUTOS = 120;

/**
 * El rato concreto de ESE contacto, siempre el mismo.
 *
 * Se deriva de su id en vez de sortearlo en cada vuelta: con `Math.random()` el
 * plazo cambiaría cada dos minutos y, en cuanto saliera un número bajo, se
 * mandaría antes de tiempo. Y es distinto para cada persona, que es justo lo
 * que hace que no parezca un lote.
 */
export function minutosHastaElNudge(contactoId: string): number {
  let h = 0;
  for (const c of contactoId) h = (h * 31 + c.charCodeAt(0)) % 1_000_003;
  return NUDGE_MIN_MINUTOS + (h % (NUDGE_MAX_MINUTOS - NUDGE_MIN_MINUTOS + 1));
}

/**
 * El "¿qué tal?" lo escribe el agente, con el playbook de la empresa.
 *
 * Si falla —sin saldo, modelo caído— se manda el texto de respaldo: es mejor
 * un mensaje algo genérico que dejar colgada una conversación que iba bien.
 */
export async function redactarQueTal(opciones: {
  campaignId: string;
  leadId: string;
  nombre: string;
  recursoPedido: string;
  modelo: string;
}): Promise<string> {
  try {
    const systemPrompt = await promptDeCampana(
      opciones.campaignId,
      opciones.leadId,
    );
    if (!systemPrompt) return PITCH_REUNION;

    const r = await chat({
      model: opciones.modelo,
      maxTokens: 400,
      temperature: 0.8,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            `Hace un rato ${opciones.nombre} comentó "${opciones.recursoPedido}" en una publicación nuestra, le pediste que te siguiera, te siguió y le mandaste el recurso. No ha dicho nada desde entonces.`,
            "",
            "Escríbele como le escribirías a alguien con quien ya has hablado hoy: pregúntale si le ha podido echar un ojo y ofrécele enseñarle cómo se aplica a su caso.",
            "",
            "Nada de presentarte otra vez ni de recordarle quién eres: ya lo sabe. Ni «espero que te haya gustado», que no lo dice nadie. Dos líneas como mucho, en el tono de un mensaje de Instagram, y cierra con una pregunta fácil de contestar.",
            "",
            "Devuelve SOLO el texto del mensaje.",
          ].join("\n"),
        },
      ],
    });
    const texto = r.text.trim();
    return texto.length > 0 && texto.length < 600 ? texto : PITCH_REUNION;
  } catch {
    return PITCH_REUNION;
  }
}

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
/**
 * Cuántos comentarios se piden en una relectura.
 *
 * El actor los devuelve ordenados por MÁS NUEVOS, así que pedir los últimos
 * treinta basta para no perderse nada entre lectura y lectura, y hace que el
 * coste NO crezca con el post: pedía doscientos, y en un post con doscientos
 * comentarios cada relectura costaba doscientos resultados para descubrir los
 * dos nuevos. Con lecturas cada pocos minutos eso son decenas de euros al día
 * por imán.
 */
export const COMENTARIOS_POR_RELECTURA = 30;

/** La primera vez sí se lee entero: el post puede llevar días publicado. */
export const COMENTARIOS_PRIMERA_LECTURA = 200;

/**
 * Cada cuánto releer, según lo viejo que sea el imán.
 *
 * Los comentarios de un post de Instagram llegan casi todos en las primeras
 * horas. Leer cada dos minutos para siempre es pagar todo el día por una curva
 * que se apagó la primera tarde; leer cada hora siempre es hacer esperar una
 * hora justo cuando más gente está comentando.
 */
export function minutosEntreLecturas(
  creadoEn: Date,
  ahora = new Date(),
): number {
  const horas = (ahora.getTime() - creadoEn.getTime()) / 3_600_000;
  if (horas < 6) return 2;
  if (horas < 48) return 15;
  return 60;
}

export async function leerComentarios(
  postUrl: string,
  clave: string,
  limite = COMENTARIOS_POR_RELECTURA,
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
 * Mientras alguien acaba de recibir el "dale a seguir", se mira casi en
 * continuo — pero solo a los recién llegados y solo un rato.
 *
 * Quien va a seguir lo hace en los minutos siguientes, y la mayoría no avisa:
 * le da a seguir y se queda esperando. Sin esto, ese silencio costaba hasta
 * seis horas de espera por un recurso prometido "ahora mismo".
 *
 * Sale barato porque se piden solo los cincuenta seguidores más recientes, que
 * es exactamente donde estaría: la lista viene ordenada por los últimos. A
 * 0,00175 $ el perfil son unos céntimos por comprobación, y solo se paga
 * durante la media hora siguiente a pedirlo.
 */
export const MINUTOS_DE_ESPERA_CALIENTE = 30;
export const SEGUIDORES_FRESCOS_CALIENTE_MIN = 3;
export const SEGUIDORES_EN_ESPERA_CALIENTE = 50;

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
 * El suelo de la cadencia de lectura, cuando el post ya no es noticia.
 *
 * Lo decide `minutosEntreLecturas`, que empieza en dos minutos y va aflojando:
 * un lead magnet se juega casi todo en las primeras horas, y una hora de espera
 * justo entonces es la diferencia entre parecer instantáneo y parecer roto.
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
export async function refrescarSeguidores(
  accountId: string,
  limite: number = SEGUIDORES_POR_REFRESCO,
): Promise<number> {
  const { usuario } = await usuarioDeCuenta(accountId);

  const items = await runSync<SeguidorApify>(
    ACTORES_LECTURA.seguidoresInstagram,
    {
      usernames: [usuario],
      dataToScrape: "followers",
      resultsLimit: limite,
    },
    { maxItems: limite, timeoutSecs: 240 },
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
  limite: number = SEGUIDORES_POR_REFRESCO,
): Promise<number> {
  const visto = await seguidoresVistosEn(accountId);
  if (visto && Date.now() - visto.getTime() <= frescuraMin * 60_000) return -1;
  return refrescarSeguidores(accountId, limite);
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
    const r = await enviarEnConversacion({
      accountId: cuenta.unipileAccountId,
      providerId: opciones.providerId,
      chatId: opciones.chatId,
      texto,
    });
    const messageId = r.message_id;
    const chatId = r.chat_id;

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
 * Se mira ANTES de cada mensaje que no sea el primero, y se mira contra
 * NUESTROS propios toques entrantes, no contra Unipile.
 *
 * Antes preguntaba a Unipile por el `chat_id` guardado, y ese identificador no
 * se puede volver a leer: es el que devuelve la API al CREAR el chat, y en
 * cuanto la conversación existe de verdad responde 404 "Chat not found". El 404
 * salía por la excepción del ciclo, sumaba un intento al contacto y a los tres
 * el contacto se descartaba solo. Es decir: TODO el que recibía el primer DM
 * acababa descartado sin llegar a recibir el recurso, y en el registro parecía
 * un usuario irresoluble.
 *
 * Leerlo de la base es además más fiable: el webhook de entrantes y el barrido
 * dejan ahí cada mensaje que nos llega, y así decidir si se puede escribir a
 * alguien no depende de ninguna llamada de red.
 */
export async function pidioQueLeDejen(leadId: string): Promise<boolean> {
  const entrantes = await db
    .select({ body: touches.body })
    .from(touches)
    .where(and(eq(touches.leadId, leadId), eq(touches.direction, "in")))
    .orderBy(desc(touches.createdAt))
    .limit(20);
  return entrantes.some((t) => pideQueLeDejen(t.body));
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
/** Cuándo salió de verdad nuestro último mensaje a ese lead. */
export async function ultimoMensajeNuestro(
  leadId: string,
): Promise<Date | null> {
  const [fila] = await db
    .select({ cuando: touches.createdAt })
    .from(touches)
    .where(
      and(
        eq(touches.leadId, leadId),
        eq(touches.direction, "out"),
        // Solo lo que SALIÓ. Un intento fallido no es haber hablado.
        eq(touches.status, "enviado"),
      ),
    )
    .orderBy(desc(touches.createdAt))
    .limit(1);
  return fila?.cuando ?? null;
}

/** Si a ese contacto se le escribió hace poco y todavía está esperando. */
export async function esperaReciente(
  contacto: Contacto,
  minutos: number,
): Promise<boolean> {
  if (!contacto.leadId) return false;
  const cuando = await ultimoMensajeNuestro(contacto.leadId);
  return Boolean(cuando && Date.now() - cuando.getTime() < minutos * 60_000);
}

export async function contestoDespuesDePedirle(
  contacto: Contacto,
): Promise<boolean> {
  if (!contacto.leadId) return false;

  /**
   * Se compara con NUESTRO último mensaje, no con `updated_at` de la fila.
   *
   * Con `updated_at` cualquier retoque de contabilidad —sumar un intento,
   * corregir un contador— movía el reloj hacia delante y la respuesta que
   * estaba esperando pasaba a contar como antigua. La pregunta de verdad es
   * "¿ha hablado después de que hablásemos nosotros?", y eso lo dicen los
   * mensajes, no la fila.
   *
   * De paso evita repetir el recordatorio: en cuanto sale, el último mensaje
   * vuelve a ser nuestro y no se dispara otra vez hasta que conteste.
   */
  const nuestro = await ultimoMensajeNuestro(contacto.leadId);
  if (!nuestro) return false;

  const [suyo] = await db
    .select({ id: touches.id })
    .from(touches)
    .where(
      and(
        eq(touches.leadId, contacto.leadId),
        eq(touches.direction, "in"),
        gt(touches.createdAt, nuestro),
      ),
    )
    .limit(1);
  return Boolean(suyo);
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
   *
   * Al terminar se SUELTA. Antes no, y esos cinco minutos funcionaban como un
   * intervalo mínimo entre ciclos: un mensaje entrante que quisiera hacer
   * avanzar a alguien justo después del cron se encontraba la puerta cerrada y
   * había que esperar. El arrendamiento es para que no corran dos a la vez, no
   * para espaciarlos.
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

  try {
    const ajustes = await ajustesEfectivos(iman.workspaceId);

    /* ---- 1. Comentarios nuevos, como mucho una vez por hora -------------- */
    const primeraVez = !iman.comentariosLeidosAt;
    const tocaLeer =
      primeraVez ||
      Date.now() - iman.comentariosLeidosAt!.getTime() >
        minutosEntreLecturas(iman.createdAt) * 60_000;

    let comentarios: ComentarioClave[] = [];
    let nuevos = 0;
    if (tocaLeer) {
      comentarios = await leerComentarios(
        iman.postUrl,
        iman.keyword,
        primeraVez ? COMENTARIOS_PRIMERA_LECTURA : COMENTARIOS_POR_RELECTURA,
      );
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
      let alguienAcabaDePedirlo = false;
      for (const c of enEspera) {
        if (!alguienContesto && (await contestoDespuesDePedirle(c))) {
          alguienContesto = true;
        }
        if (
          !alguienAcabaDePedirlo &&
          (await esperaReciente(c, MINUTOS_DE_ESPERA_CALIENTE))
        ) {
          alguienAcabaDePedirlo = true;
        }
        if (alguienContesto && alguienAcabaDePedirlo) break;
      }

      /**
       * Tres ritmos, de más urgente a más barato: quien acaba de contestar,
       * quien acaba de recibir la petición y sigue callado, y el resto. Los
       * dos primeros piden solo los seguidores más recientes, que es donde
       * estaría alguien que acaba de darle a seguir.
       */
      const cacheados = alguienContesto
        ? await refrescarSiHaceFalta(
            cuenta.id,
            SEGUIDORES_FRESCOS_SI_CONTESTAN_MIN,
            SEGUIDORES_EN_ESPERA_CALIENTE,
          )
        : alguienAcabaDePedirlo
          ? await refrescarSiHaceFalta(
              cuenta.id,
              SEGUIDORES_FRESCOS_CALIENTE_MIN,
              SEGUIDORES_EN_ESPERA_CALIENTE,
            )
          : await refrescarSiHaceFalta(cuenta.id);
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
      sinCupo: (cupo.hay
        ? null
        : { motivo: cupo.motivo, detalle: cupo.detalle }) as {
        motivo: string;
        detalle?: string;
      } | null,
    };

    /* ---- 2 bis. La ventana de envío, pero solo para lo que no ha pedido -- */
    /**
     * Un imán no es prospección en frío, y no puede tratarse igual.
     *
     * La ventana existe para no meterse en el móvil de alguien a las cuatro de
     * la mañana sin que te haya llamado nadie. Aquí SÍ te han llamado: acaban
     * de comentar la palabra pidiendo el recurso. Hacerle esperar a mañana a
     * quien acaba de escribir "RESEÑA" a las once de la noche rompe la única
     * promesa del embudo —"te lo mando ahora mismo"— y es exactamente lo que
     * hace que no se parezca a las herramientas que la gente ya usa.
     *
     * Así que la ventana solo frena lo que sale por iniciativa nuestra: el
     * "¿qué tal?" de después de entregar. Pedir el follow y entregar el recurso
     * son respuestas, y una respuesta se da cuando te preguntan.
     *
     * El tope horario de la cuenta (8/h en Instagram) sigue aplicando siempre:
     * eso es lo que protege la cuenta, no la hora del día.
     */
    const [campana] = await db
      .select({ ventana: campaigns.sendingWindow })
      .from(campaigns)
      .where(eq(campaigns.id, await campanaDelIman(iman)));

    const fuera = campana ? fueraDeVentana(campana.ventana, new Date()) : null;

    /* ---- 3. Avanzar a cada uno un paso ---------------------------------- */
    for (const contacto of await contactosPendientes(iman.id, LOTE)) {
      try {
        // Si en algún momento pidió que le dejaran en paz, se para aquí y no
        // recibe nada más, ni una despedida.
        //
        // Va ANTES de la rama de `pidiendo_follow`: estaba después, y como esa
        // rama termina siempre en `continue`, a quien decía "no me escribas"
        // mientras esperaba el follow no se le hacía ni caso.
        if (contacto.leadId && (await pidioQueLeDejen(contacto.leadId))) {
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
            if (
              await moverA(contacto, "verificado", { verifiedAt: new Date() })
            )
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
            continue;
          }

          /**
           * Ha dicho dos veces que ya sigue y no aparece. Se le da igualmente.
           *
           * No es ceder por ceder: la lista de seguidores viene acotada a los
           * más recientes, así que puede fallar, y quien insiste dos veces casi
           * siempre ha seguido de verdad. Perder a alguien que sí siguió cuesta
           * mucho más que regalar un recurso, y quedarse callado después de que
           * te digan "listo" dos veces es lo que hace que parezca un bot roto.
           */
          if (
            contacto.followAsks >= MAX_PETICIONES_DE_FOLLOW &&
            (await contestoDespuesDePedirle(contacto))
          ) {
            if (
              await moverA(contacto, "verificado", { verifiedAt: new Date() })
            ) {
              resumen.verificados++;
              await db.insert(runLogs).values({
                workflow: "iman",
                leadId: contacto.leadId,
                level: "info",
                message: `@${contacto.username} dice que sigue y no sale en la lista, pero ha insistido: se le entrega el recurso igualmente.`,
                payload: { magnetId: iman.id, contactId: contacto.id },
              });
            }
          }
          continue;
        }

        if (presupuesto <= 0) continue;

        if (contacto.state === "entregado") {
          if (!iman.pitchMeeting) continue;

          // Lo único que sale por iniciativa nuestra, y por eso lo único que
          // espera a que sean horas.
          if (fuera) {
            resumen.sinCupo ??= { motivo: "fuera_de_ventana", detalle: fuera };
            continue;
          }

          /**
           * Si ya está hablando contigo, no le preguntes "¿qué tal?".
           *
           * En cuanto contesta, la conversación es del agente: la ve entera y
           * responde en segundos por el webhook. Soltarle encima un mensaje
           * programado es exactamente lo que delata a un bot.
           */
          if (await contestoDespuesDePedirle(contacto)) {
            if (await moverA(contacto, "en_conversacion"))
              resumen.enConversacion++;
            continue;
          }

          // Y si no ha dicho nada, se le da su rato antes de preguntar.
          const entregadoEn = contacto.deliveredAt?.getTime();
          if (
            entregadoEn &&
            Date.now() - entregadoEn < minutosHastaElNudge(contacto.id) * 60_000
          ) {
            continue;
          }
        }

        const identidad = await asegurarLead(iman, contacto, cuenta);
        /**
         * Solo para el PRIMER mensaje.
         *
         * Sirve para no empezar una segunda secuencia con alguien al que esta
         * cuenta ya escribió hoy —otro imán sobre otro post, o la campaña en
         * frío—, porque en Instagram el hilo es único y serían dos secuencias
         * en el mismo chat.
         *
         * Aplicarlo a los pasos siguientes era otra cosa muy distinta: frenaba
         * la propia conversación. Alguien que acababa de seguir para recibir el
         * recurso se quedaba sin él por haber recibido justo antes la petición
         * de follow, es decir, por haber hecho exactamente lo que se le pidió.
         */
        if (
          contacto.state === "detectado" &&
          identidad &&
          (await yaEscritoHoy(cuenta.id, identidad.providerId))
        ) {
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

        let envio: {
          enviado: boolean;
          motivo?: string;
          chatId?: string | null;
        };
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
                : await redactarQueTal({
                    campaignId: await campanaDelIman(iman),
                    leadId: identidad.leadId,
                    nombre: contacto.fullName || contacto.username,
                    recursoPedido: iman.keyword,
                    modelo: ajustes.openrouterModel,
                  });

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
  } finally {
    // Se suelta pase lo que pase, incluido el `return` de "fuera de ventana".
    await db
      .update(leadMagnets)
      .set({ lastCheckedAt: null })
      .where(eq(leadMagnets.id, iman.id));
  }
}
