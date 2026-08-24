/**
 * Montaje del prompt del agente.
 *
 * Este fichero es la razón de que el botón "Probar" sirva de algo: la pantalla
 * de pruebas y el playbook que consume n8n pasan por AQUÍ, por la misma función.
 * Si el ensayo montara el prompt de otra manera, estarías probando un agente
 * distinto del que luego escribe a la gente.
 */
import type {
  BookingRules,
  Enrichment,
  IcpSignal,
  Lecciones,
  Objection,
  QualificationCriterion,
} from "./db/schema";
import { sinCifrasDeDinero } from "./sin-precios";

export type PlaybookParaPrompt = {
  systemPrompt: string;
  offer: string;
  qualificationCriteria: QualificationCriterion[];
  objections: Objection[];
  bookingRules: BookingRules;
};

export type IcpParaPrompt = {
  name: string;
  description: string | null;
  criteria: IcpSignal[];
  disqualifiers: IcpSignal[];
};

/** La empresa para la que se vende en esta campaña. */
export type EmpresaVendedora = {
  name: string;
  website: string | null;
  context: string | null;
  scrapedContext: string | null;
  offer: string | null;
};

export type ContextoPrompt = {
  empresa: string;
  canal: "linkedin" | "email" | "instagram";
  /** Contexto de la empresa vendedora. Sustituye a `empresa` si viene. */
  vendedora?: EmpresaVendedora | null;
  /** Lo aprendido de los resultados reales del propio sistema. */
  lecciones?: Lecciones | null;
  /** Lo que se averiguó de ESTE prospecto antes de escribirle. */
  enriquecimiento?: Enrichment | null;
};

const NOMBRE_CANAL: Record<ContextoPrompt["canal"], string> = {
  linkedin: "mensaje directo de LinkedIn",
  instagram: "mensaje directo de Instagram",
  email: "email",
};

function seccion(titulo: string, cuerpo: string): string {
  return cuerpo.trim() ? `\n\n# ${titulo}\n\n${cuerpo.trim()}` : "";
}

/**
 * Dos cosas que el agente hizo mal la primera vez que contestó de verdad, y que
 * no dependen del playbook de nadie: van en el código.
 *
 * La primera: contestó a una autorespuesta. Le escribió «cuando estés al otro
 * lado, retomamos» a un buzón que solo devuelve un enlace. Gasta un envío del
 * cupo del día y no lo lee nadie.
 *
 * La segunda: cerró el lead y DESPUÉS intentó despedirse. El sistema bloquea
 * cualquier envío a un lead cerrado —eso está bien y no se toca—, así que la
 * despedida se perdió y el prospecto, que había contestado educadamente, se
 * quedó sin respuesta. El orden importa y hay que decirlo aquí, porque el
 * agente no puede deducirlo del error: cuando lo ve, ya es tarde.
 */
/**
 * Lo que separa un mensaje de una persona de uno de un sistema.
 *
 * Nada de esto es cuestión de gusto: son las costuras por las que se nota el
 * molde. Un modelo, si no se le dice, se presenta en cada mensaje, contesta a
 * lo que él quería hablar en vez de a lo que le han preguntado, y escribe tres
 * párrafos donde el otro ha escrito dos palabras.
 *
 * Va en el código y no en el playbook porque no es el método de venta de nadie:
 * es cómo se escribe por un chat.
 */
const COMO_SE_ESCRIBE = [
  "Estás en un chat, no escribiendo un correo.",
  "",
  "- No te presentes más de una vez. Si ya habéis hablado hoy, ya sabe quién eres.",
  "- Contesta PRIMERO a lo que te acaban de decir. Solo después lleva la conversación a donde quieras.",
  "- Una pregunta por mensaje. Dos seguidas se quedan sin contestar las dos.",
  "- Ajústate a su tamaño: si te escriben tres palabras, no respondas con un párrafo.",
  "- Nada de «espero que estés bien», «te escribo porque» ni «no dudes en consultarme». Eso no lo dice nadie por Instagram.",
  "- Si te dicen que sí a la reunión, no celebres: mira la agenda y propón horas.",
  "- Nunca digas que eres un bot ni que no lo eres. Si te lo preguntan directamente, no lo niegues y sigue siendo útil.",
  "",
  "Vas a por una reunión, y esa es la única meta. Pero no la pidas en cada mensaje: si todavía no sabes si encaja, pregunta; si ya sabes que sí, propón día.",
].join("\n");

const ANTES_DE_CONTESTAR = [
  "No todo lo que entra lo ha escrito una persona.",
  "",
  "Si el mensaje es una AUTORESPUESTA —«estoy de vacaciones», «fuera de la",
  "oficina», «te contestamos en breve», «visita este enlace»—, no contestes.",
  "Nadie lo va a leer, gasta un envío del cupo del día y deja huella de bot.",
  "Deja el lead como está y espera a que conteste la persona.",
  "",
  "Y si vas a despedirte, ESCRIBE PRIMERO y cierra después. En cuanto marcas",
  "el lead como descartado o no interesado, el sistema bloquea cualquier envío",
  "a esa persona: si cierras antes, tu despedida no sale y quien te contestó de",
  "buenas maneras se queda sin respuesta.",
].join("\n");

export function construirSystemPrompt(
  playbook: PlaybookParaPrompt,
  icp: IcpParaPrompt | null,
  contexto: ContextoPrompt,
): string {
  // Los marcadores del playbook se resuelven aquí para que quien escribe el
  // playbook pueda hablar de "{{empresa}}" sin saber de dónde sale el valor.
  const base = playbook.systemPrompt
    .replaceAll("{{empresa}}", contexto.vendedora?.name ?? contexto.empresa)
    .replaceAll("{{canal}}", NOMBRE_CANAL[contexto.canal]);

  const criterios = playbook.qualificationCriteria
    .map(
      (c) =>
        `- [${c.id}] (peso ${c.weight}) ${c.question}` +
        (c.inferable_from
          ? `\n  Cómo inferirlo sin preguntar: ${c.inferable_from}`
          : ""),
    )
    .join("\n");

  const objeciones = playbook.objections
    .map((o) => `## "${o.objection}"\n${o.response}`)
    .join("\n\n");

  const r = playbook.bookingRules;
  const dias = [
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
    "domingo",
  ];
  const reglasAgenda = [
    `- Duración de la reunión: ${r.duration_min} minutos.`,
    `- No propongas nada que empiece antes de ${r.min_notice_hours} h desde ahora.`,
    `- Deja ${r.buffer_min} min de colchón antes y después de cada reunión.`,
    `- Horario: ${r.working_hours.from}–${r.working_hours.to} (${r.timezone}), ${r.working_hours.days.map((d) => dias[d - 1]).join(", ")}.`,
    `- Ofrece como mucho ${r.max_slots_offered} huecos por mensaje. Más satura y retrasa la decisión.`,
    `- No puedes agendar con un score por debajo de ${r.min_score_to_book}. Es un umbral duro, no una guía.`,
  ].join("\n");

  const icpTexto = icp
    ? [
        icp.description ?? "",
        "",
        "Señales de que ENCAJA:",
        ...icp.criteria.map(
          (c) => `- ${c.signal}${c.source ? ` (se ve en: ${c.source})` : ""}`,
        ),
        "",
        "Señales de que hay que DESCARTAR sin conversación:",
        ...icp.disqualifiers.map(
          (d) => `- ${d.signal}${d.source ? ` (se ve en: ${d.source})` : ""}`,
        ),
      ].join("\n")
    : "";

  const v = contexto.vendedora;

  const quienesSomos = v
    ? [
        v.website ? `Web: ${v.website}` : "",
        v.context ?? "",
        // Lo scrapeado va después de lo escrito a mano y marcado como tal: si se
        // contradicen, manda lo que puso la persona.
        v.scrapedContext
          ? `\nDe su web:\n${sinCifrasDeDinero(v.scrapedContext)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const leccionesTexto = contexto.lecciones
    ? [
        `Sacado de ${contexto.lecciones.basadoEn} mensajes ya enviados y de lo que contestaron.`,
        "",
        ...(contexto.lecciones.funciona.length
          ? [
              "LO QUE ESTÁ FUNCIONANDO:",
              ...contexto.lecciones.funciona.map((l) => `- ${l}`),
            ]
          : []),
        "",
        ...(contexto.lecciones.noFunciona.length
          ? [
              "LO QUE NO:",
              ...contexto.lecciones.noFunciona.map((l) => `- ${l}`),
            ]
          : []),
      ].join("\n")
    : "";

  const sobreEste = contexto.enriquecimiento?.resumen ?? "";

  /**
   * El primer mensaje de LinkedIn no es un mensaje: es la nota de una
   * invitación de contacto, y LinkedIn la corta en 200 caracteres.
   *
   * En frío no se puede mandar un DM a quien no es contacto de primer grado, así
   * que lo que sale es la invitación. Se le dice al agente para que escriba a
   * esa medida; el recorte automático es la red de seguridad, no el plan: una
   * frase cortada a la mitad es la peor primera impresión posible.
   */
  const limiteDelCanal =
    contexto.canal === "linkedin"
      ? [
          "Tu primer mensaje va como NOTA DE UNA INVITACIÓN de contacto, y LinkedIn no",
          "admite más de 200 caracteres. No son 200 palabras: son 200 letras, unas dos",
          "frases. Si te pasas, se corta. Escribe una sola idea concreta y una pregunta",
          "corta; ya habrá sitio para el resto cuando acepte.",
        ].join("\n")
      : "";

  return [
    base.trim(),
    seccion("El tamaño que admite este canal", limiteDelCanal),
    seccion("Antes de contestar, mira QUÉ has recibido", ANTES_DE_CONTESTAR),
    seccion("Cómo se escribe por aquí", COMO_SE_ESCRIBE),
    seccion("Quiénes somos", quienesSomos),
    seccion("Qué vendemos", sinCifrasDeDinero(v?.offer || playbook.offer)),
    seccion(`A quién buscamos: ${icp?.name ?? "sin ICP definido"}`, icpTexto),
    seccion(
      "Qué tienes que averiguar (máximo 2 preguntas en toda la conversación)",
      criterios
        ? `${criterios}\n\nEl resto lo infieres del perfil y de lo que te cuente. Registra el resultado con \`registrar_cualificacion\`.`
        : "",
    ),
    seccion("Objeciones y cómo responderlas", objeciones),
    seccion("Reglas de agendado", reglasAgenda),
    seccion(
      "Lo que hemos aprendido de nuestros propios resultados",
      leccionesTexto
        ? `${leccionesTexto}\n\nEsto pesa más que cualquier corazonada: sale de mensajes reales.`
        : "",
    ),
    seccion(
      "Sobre ESTA persona en concreto",
      sobreEste
        ? `${sobreEste}\n\nUsa un detalle concreto de aquí en el mensaje. No lo recites entero ni lo enumeres: uno solo, bien traído, y sigue. Y si algo no está aquí, no te lo inventes.`
        : "",
    ),
  ]
    .filter(Boolean)
    .join("");
}
