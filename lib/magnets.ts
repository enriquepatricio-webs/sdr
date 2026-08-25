/**
 * El motor del lead magnet, sin nada que hable con Instagram.
 *
 * Instagram salió del producto: los DMs iban por Unipile y los comentarios y
 * seguidores por Apify, y todo eso está borrado. Lo que queda es lo que no
 * depende de por dónde entren ni salgan los mensajes —detectar la palabra
 * clave, el embudo, cuándo toca escribir y qué se dice— porque es exactamente
 * lo que reutiliza la versión con la app de Meta.
 *
 * Todo lo de aquí es puro: sin red y sin base de datos. Por eso se puede probar
 * entero con `npm run test:imanes`, y por eso sigue vivo aunque ahora mismo no
 * lo llame nadie.
 */
import { magnetStateEnum } from "./db/schema";

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
/**
 * El mensaje con el que se entrega el recurso.
 *
 * Lo escribe el agente y no una plantilla, porque el mismo texto palabra por
 * palabra a todo el que comenta es lo primero que delata a un bot. El recurso
 * va tal cual lo puso la persona: eso NO lo reescribe nadie.
 */
export function promptDeEntrega(opciones: {
  nombre: string;
  clave: string;
  recurso: string;
  comentario: string;
}): string {
  return [
    `${opciones.nombre} acaba de comentar "${opciones.comentario}" en una publicación nuestra, pidiendo el recurso con la palabra "${opciones.clave}".`,
    "",
    "Escríbele por privado entregándoselo. Dos líneas como mucho, en el tono de un mensaje de Instagram: le has visto el comentario y se lo mandas.",
    "",
    `El recurso es esto y va TAL CUAL, sin cambiar ni una letra ni añadirle nada alrededor: ${opciones.recurso}`,
    "",
    "Nada de presentarte, nada de «espero que te sirva», nada de pedir nada a cambio. Y cierra con UNA pregunta corta y fácil que invite a contestar, para que la conversación pueda seguir.",
    "",
    "Devuelve SOLO el texto del mensaje.",
  ].join("\n");
}

/**
 * Lo que se contesta en público, colgando del comentario.
 *
 * Corto a propósito: lo lee todo el que pase por el post, y su único trabajo es
 * que se vea que se ha atendido. La conversación de verdad va por privado.
 */
export const RESPUESTA_PUBLICA = [
  "¡Va por privado! 📩",
  "Te lo acabo de mandar por privado 📩",
  "Enviado por privado 📩",
];

export const RECORDATORIO_FOLLOW =
  "Gracias, pero todavía no me sale que me sigas. Dale a seguir y te lo mando al momento; si ya le has dado, dame un minuto y vuelve a escribirme.";
