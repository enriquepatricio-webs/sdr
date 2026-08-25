/**
 * Prospección asistida: del ICP a una lista de candidatos puntuados.
 *
 * Tres pasos, y el reparto de responsabilidades importa:
 *   1. El LLM traduce el ICP a los FILTROS de un actor de Apify. Rellena un
 *      formulario acotado con enums; no elige el actor ni compone la petición.
 *   2. Apify ejecuta y devuelve perfiles crudos.
 *   3. El LLM puntúa cada perfil contra el ICP, en lotes.
 *
 * Nada de esto escribe en `leads`: los candidatos se quedan en `prospects`
 * hasta que una persona decide a quién importar.
 */
import type { IcpSignal } from "./db/schema";
import { type ProspectSource, SUPPORTED_ACTORS } from "./apify";
import { type Usage, chatJson } from "./openrouter";

export type IcpParaProspeccion = {
  name: string;
  description: string | null;
  criteria: IcpSignal[];
  disqualifiers: IcpSignal[];
};

/* -------------------------------------------------------------------------- */
/* 1. ICP -> filtros del actor                                                 */
/* -------------------------------------------------------------------------- */

/**
 * El LLM solo puede rellenar estos campos, y los de enum solo con estos valores.
 *
 * Deliberadamente NO se expone `industryIds` (exige códigos numéricos de un CSV
 * externo y el modelo se los inventa) ni `maxItems` (el tope de gasto lo pone el
 * usuario, no el modelo) ni nada de MongoDB.
 */
const SCHEMA_LINKEDIN = {
  type: "object",
  additionalProperties: false,
  properties: {
    personTitleIncludes: {
      type: "array",
      items: { type: "string" },
      description:
        'Cargos, entre uno y tres. Ej: ["Fundador","CEO","Director de Marketing"]. Se buscan también variantes en inglés.',
    },
    seniorityIncludes: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "c_suite",
          "vp",
          "director",
          "manager",
          "senior",
          "entry",
          "owner",
          "partner",
        ],
      },
      description:
        "Nivel de decisión. Para quien decide la compra: owner, c_suite, partner y director.",
    },
    functionIncludes: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "marketing",
          "sales",
          "operations",
          "business_development",
          "finance",
          "consulting",
          "education",
          "engineering",
          "information_technology",
          "human_resources",
          "support",
        ],
      },
      description:
        "Departamento. Úsalo solo si el ICP habla de un área concreta.",
    },
    personLocationCountryIncludes: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "Spain",
          "Mexico",
          "Argentina",
          "Colombia",
          "Chile",
          "Peru",
          "United States",
          "United Kingdom",
          "France",
          "Italy",
          "Germany",
        ],
      },
      description: 'País de la persona, en inglés. Por defecto ["Spain"].',
    },
    personLocationCityIncludes: {
      type: "array",
      items: { type: "string" },
      description:
        "Ciudades concretas. Cambiar de ciudad es un buen ángulo nuevo.",
    },
    companyIndustryIncludes: {
      type: "array",
      items: { type: "string" },
      description:
        'Sectores de la empresa. Ej: ["hospital & health care","real estate"].',
    },
    companyKeywordIncludes: {
      type: "array",
      items: { type: "string" },
      description:
        "Palabras que aparecen en el nombre o la descripción de la empresa. Es lo más potente para acotar un ICP raro.",
    },
    companySizeIncludes: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "1-10",
          "11-50",
          "51-200",
          "201-500",
          "501-1000",
          "1001-5000",
          "5001-10000",
          "10001+",
        ],
      },
      description: "Plantilla de la empresa.",
    },
    razonamiento: {
      type: "string",
      description:
        "Por qué estos filtros y no otros, en dos frases. Es lo que se lee cuando la búsqueda sale mal.",
    },
    angulo: {
      type: "string",
      description:
        'Etiqueta corta de este ángulo, máximo ocho palabras. Ej: "dueños de clínicas dentales en Valencia".',
    },
  },
  required: ["personTitleIncludes", "razonamiento", "angulo"],
} as const;

const SCHEMA_INSTAGRAM = {
  type: "object",
  additionalProperties: false,
  properties: {
    search: {
      type: "string",
      description:
        'Término de búsqueda o hashtag sin almohadilla. Ej: "consultoria b2b".',
    },
    searchType: {
      type: "string",
      enum: ["user", "hashtag"],
      description:
        "user busca perfiles por nombre; hashtag busca quién publica bajo ese hashtag.",
    },
    razonamiento: {
      type: "string",
      description: "Por qué ese término, en dos frases.",
    },
    angulo: {
      type: "string",
      description: "Etiqueta corta del ángulo, máximo ocho palabras.",
    },
  },
  required: ["search", "searchType", "razonamiento", "angulo"],
} as const;

/**
 * Google Maps. Deliberadamente pequeño.
 *
 * NO se expone `categoryFilterWords`: son más de 4.000 categorías cerradas, el
 * modelo se inventa las que no existen y el propio actor avisa de que filtrar
 * por categoría produce falsos negativos porque muchos negocios se categorizan
 * mal. Se filtra por término de búsqueda, que es como busca una persona.
 *
 * `locationQuery` va de a UNA ubicación por ejecución: es limitación del actor.
 * Cambiar de ciudad es, de hecho, el mejor ángulo nuevo para reabastecer.
 */
const SCHEMA_MAPS = {
  type: "object",
  additionalProperties: false,
  properties: {
    searchStringsArray: {
      type: "array",
      items: { type: "string" },
      description:
        'Lo que escribirías en la barra de Google Maps, en el idioma del país. Ej: ["restaurante","cafetería"]. Entre dos y cuatro términos.',
    },
    locationQuery: {
      type: "string",
      description:
        'UNA sola ubicación en texto libre. Cuanto más simple mejor: "Bilbao, España" antes que "Bilbao, Vizcaya, País Vasco, España". Puede ser una provincia o un país entero.',
    },
    placeMinimumStars: {
      type: "string",
      enum: [
        "two",
        "twoAndHalf",
        "three",
        "threeAndHalf",
        "four",
        "fourAndHalf",
      ],
      description:
        "Nota mínima. Úsalo solo si el ICP habla de calidad o de negocio consolidado: filtrar por estrellas deja fuera a los que no tienen reseñas todavía.",
    },
    razonamiento: {
      type: "string",
      description: "Por qué esos términos y esa zona, en dos frases.",
    },
    angulo: {
      type: "string",
      description:
        'Etiqueta corta del ángulo, máximo ocho palabras. Ej: "cafeterías de especialidad en Sevilla".',
    },
  },
  required: ["searchStringsArray", "locationQuery", "razonamiento", "angulo"],
} as const;

const SCHEMAS = {
  linkedin: SCHEMA_LINKEDIN,
  email: SCHEMA_MAPS,
} as const satisfies Record<ProspectSource, unknown>;

function describirIcp(icp: IcpParaProspeccion): string {
  return [
    `ICP: ${icp.name}`,
    icp.description ?? "",
    "",
    "ENCAJA quien cumple:",
    ...icp.criteria.map((c) => `- ${c.signal}`),
    "",
    "NO encaja quien:",
    ...icp.disqualifiers.map((d) => `- ${d.signal}`),
  ].join("\n");
}

export type FiltrosTraducidos = {
  input: Record<string, unknown>;
  razonamiento: string;
  angulo: string;
  usage: Usage;
};

export async function traducirIcpAFiltros(
  icp: IcpParaProspeccion,
  fuente: ProspectSource,
  brief: string | null,
  modelo: string,
  /**
   * Ángulos ya usados para este ICP. El modelo tiene que proponer uno
   * MATERIALMENTE distinto: si no, el reabastecimiento automático repetiría la
   * misma búsqueda cada vez y traería a la misma gente, que además ya está
   * importada y se descartaría entera. Búsquedas caras que no aportan nada.
   */
  angulosUsados: string[] = [],
): Promise<FiltrosTraducidos> {
  const schema = SCHEMAS[fuente];

  const evitar = angulosUsados.length
    ? [
        "",
        "YA SE HAN BUSCADO ESTOS ÁNGULOS. El tuyo tiene que ser claramente distinto,",
        "no una variación cosmética del mismo:",
        ...angulosUsados.map((a) => `- ${a}`),
        "",
        "Formas válidas de cambiar de ángulo, en este orden de preferencia:",
        "1. Otra vertical o sector adyacente que siga cumpliendo el ICP.",
        "2. Otra zona geográfica.",
        "3. Otros cargos que también decidan la compra (de fundador a director comercial).",
        "4. Otro tamaño de empresa dentro del rango del ICP.",
        "Lo que NO vale: los mismos filtros con una palabra cambiada en searchQuery.",
      ].join("\n")
    : "";

  const { data, usage } = await chatJson<
    Record<string, unknown> & { razonamiento: string; angulo: string }
  >({
    model: modelo,
    // Con ángulos previos sube la temperatura: hace falta variedad de verdad.
    temperature: angulosUsados.length ? 0.7 : 0.2,
    messages: [
      {
        role: "system",
        content: [
          `Traduces un perfil de cliente ideal a los filtros de búsqueda de ${SUPPORTED_ACTORS[fuente].label}.`,
          "",
          "Reglas:",
          "- Prefiere filtros que estrechen de verdad. Una búsqueda demasiado abierta gasta dinero y devuelve ruido.",
          "- Pero no la estreches tanto que no salga nadie: si dudas entre dos cargos, pon los dos.",
          "- Los descalificadores del ICP van a los campos de exclusión cuando exista uno.",
          "- No inventes valores de enum. Usa solo los que te da el esquema.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          describirIcp(icp),
          brief ? `\nInstrucción adicional del usuario:\n${brief}` : "",
          evitar,
        ]
          .join("\n")
          .trim(),
      },
    ],
    jsonSchema: {
      name: "filtros_de_busqueda",
      schema: schema as unknown as Record<string, unknown>,
    },
  });

  const { razonamiento, angulo, ...input } = data;
  // Un array vacío es un filtro que no filtra y confunde al leer el registro.
  const limpio = Object.fromEntries(
    Object.entries(input).filter(
      ([, v]) => !(Array.isArray(v) && v.length === 0) && v !== "",
    ),
  );
  return { input: limpio, razonamiento, angulo, usage };
}

/**
 * Los filtros que produce el modelo, más lo que decide el sistema.
 *
 * El tope de resultados se llama distinto en cada actor (`maxItems`,
 * `searchLimit`, `maxCrawledPlacesPerSearch`) y esto estaba copiado en las dos
 * rutas que lanzan búsquedas. Vive aquí para que añadir una fuente sea un solo
 * sitio y para que las dos no se desincronicen.
 */
/** Valores que la base B2B acepta. Fuera de esta lista devuelve un 400. */
const SENIORITY_VALIDOS = [
  "c_suite",
  "vp",
  "director",
  "manager",
  "senior",
  "entry",
  "owner",
  "partner",
];
const HEADCOUNT_VALIDOS = [
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5001-10000",
  "10001+",
];

/**
 * Los enums del actor de LinkedIn son CADENAS, y el modelo a veces devuelve
 * números (`310` en vez de `"310"`) o se inventa un código que no existe. El
 * actor responde 400, la búsqueda muere entera y el ángulo se desperdicia: ya
 * pasó con "clínicas de salud mental en Madrid".
 *
 * Se convierte a cadena y se descarta lo que no esté en la lista. Un filtro de
 * menos devuelve gente de más, que se recupera puntuando; un 400 no devuelve
 * nada.
 */
function soloValores(
  valor: unknown,
  permitidos: string[],
): string[] | undefined {
  if (!Array.isArray(valor)) return undefined;
  const limpio = valor
    .map((v) => String(v))
    .filter((v) => permitidos.includes(v));
  return limpio.length ? limpio : undefined;
}

export function construirEntrada(
  fuente: ProspectSource,
  filtros: Record<string, unknown>,
  maxItems: number,
): Record<string, unknown> {
  if (fuente === "linkedin") {
    const { seniorityIncludes, companySizeIncludes, ...resto } = filtros;
    return {
      ...resto,
      // Se limpian los enums: el modelo a veces devuelve valores que no existen
      // y el actor responde 400, matando la búsqueda entera con su ángulo.
      ...(soloValores(seniorityIncludes, SENIORITY_VALIDOS)
        ? {
            seniorityIncludes: soloValores(
              seniorityIncludes,
              SENIORITY_VALIDOS,
            ),
          }
        : {}),
      ...(soloValores(companySizeIncludes, HEADCOUNT_VALIDOS)
        ? {
            companySizeIncludes: soloValores(
              companySizeIncludes,
              HEADCOUNT_VALIDOS,
            ),
          }
        : {}),
      totalResults: maxItems,
      // Sin correo no se puede escribir, y esta base lo trae: pedirlo de entrada
      // evita pagar por filas que luego se descartan al normalizar.
      hasEmail: true,
      emailStatusIncludes: ["verified"],
      personLocationCountryIncludes:
        Array.isArray(resto.personLocationCountryIncludes) &&
        resto.personLocationCountryIncludes.length
          ? resto.personLocationCountryIncludes
          : ["Spain"],
    };
  }
  // Google Maps cuenta el tope POR TÉRMINO de búsqueda, no en total. Con cuatro
  // términos, pedir 50 traería 200 sitios y cuadruplicaría la factura sin que
  // nadie lo hubiese decidido. Se reparte el presupuesto entre los términos.
  const terminos = Array.isArray(filtros.searchStringsArray)
    ? filtros.searchStringsArray.length
    : 1;
  return {
    ...filtros,
    maxCrawledPlacesPerSearch: Math.max(
      5,
      Math.ceil(maxItems / Math.max(1, terminos)),
    ),
    language: "es",
    countryCode: "es",
    // Sin web no hay de dónde sacar el correo, y el correo es el único motivo
    // por el que se usa esta fuente.
    website: "withWebsite",
    scrapeContacts: true,
    skipClosedPlaces: true,
  };
}

/* -------------------------------------------------------------------------- */
/* 2. Perfil crudo -> candidato                                                */
/* -------------------------------------------------------------------------- */

export type CandidatoNormalizado = {
  fullName: string;
  /**
   * Los hechos observables que sirven para decidir si encaja.
   *
   * Sin esto, el puntuador solo veía nombre, titular, empresa y ubicación, y
   * escribía "sin datos de reseñas" sobre un local con 1.914. El dato estaba en
   * `raw`, pero `raw` no entra en el prompt: es enorme y lleno de ruido. Aquí va
   * lo poco que de verdad discrimina, ya en texto.
   */
  senales: string[];
  headline: string | null;
  company: string | null;
  location: string | null;
  linkedinUrl: string | null;
  instagramUsername: string | null;
  email: string | null;
  providerId: string | null;
  raw: Record<string, unknown>;
};

/** De "https://www.instagram.com/antares_remax/" saca "antares_remax". */
function usuarioDeUrlInstagram(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = url.match(/instagram\.com\/([A-Za-z0-9._]+)/);
  const usuario = m?.[1]?.toLowerCase();
  // Rutas de la propia plataforma, no cuentas.
  return usuario && !["p", "reel", "explore", "stories"].includes(usuario)
    ? usuario
    : null;
}

function texto(...valores: unknown[]): string | null {
  for (const v of valores) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Los actores cambian los nombres de sus campos entre versiones, así que se
 * prueban varios alias en vez de confiar en uno. Si no hay nombre ni forma de
 * contactar, se descarta la fila: un candidato incontactable no vale nada.
 */
export function normalizarCandidato(
  fuente: ProspectSource,
  item: Record<string, unknown>,
): CandidatoNormalizado | null {
  const raw = item as Record<string, any>;

  if (fuente === "linkedin") {
    /**
     * Filas planas y ricas: la persona con su cargo y su empresa ya resueltos.
     * Nada de `currentPositions` anidado, que es donde se perdía todo antes.
     */
    const nombre =
      texto(raw.fullName, raw.name) ??
      texto([raw.firstName, raw.lastName].filter(Boolean).join(" "));
    const url = texto(raw.linkedinUrl, raw.profileUrl, raw.url);
    const correo = texto(raw.email);
    // Sin una vía de contacto no vale de nada, y esta fuente da las dos.
    if (!nombre || !(url || correo)) return null;

    return {
      fullName: nombre,
      senales: [
        texto(raw.companyIndustry) ? `sector: ${raw.companyIndustry}` : "",
        texto(raw.companySizeRange, raw.companySize)
          ? `plantilla ${texto(raw.companySizeRange, raw.companySize)}`
          : "",
        raw.annualRevenue ? `facturación ${raw.annualRevenue}` : "",
        raw.foundedYear ? `fundada en ${raw.foundedYear}` : "",
        texto(raw.seniority) ? `nivel: ${raw.seniority}` : "",
        Array.isArray(raw.technologies) && raw.technologies.length
          ? `usa: ${raw.technologies.slice(0, 8).join(", ")}`
          : "",
        // La descripción de la empresa es lo que mejor dice a qué se dedica.
        texto(raw.companyDescription)
          ? `la empresa se describe así: ${String(raw.companyDescription).slice(0, 400)}`
          : "",
        raw.emailStatus ? `correo ${raw.emailStatus}` : "",
      ].filter((x): x is string => Boolean(x)),
      headline: texto(raw.title, raw.position),
      company: texto(raw.companyName),
      location: texto(
        [raw.personCity, raw.personState, raw.personCountry]
          .filter(Boolean)
          .join(", "),
        raw.companyCity,
      ),
      linkedinUrl: url,
      instagramUsername: null,
      email: correo,
      // El id de esta base NO es un provider_id de Unipile. Ponerlo aquí hacía
      // que el envío intentara escribir a un destinatario inexistente y Unipile
      // respondiera 422 "invalid_recipient": ochenta y cuatro leads quemados en
      // una mañana. Se deja vacío y se resuelve al enviar, desde la URL.
      providerId: null,
      raw: item,
    };
  }

  if (fuente === "email") {
    const nombre = texto(raw.title, raw.name, raw.placeName);
    // Los emails vienen de `scrapeContacts`, que entra en la web del negocio.
    // Sin correo no hay a quién escribirle: la fila no vale para esta campaña.
    const correos = Array.isArray(raw.emails) ? raw.emails : [];
    const correo = texto(correos[0], raw.email, raw.contactEmail);
    if (!nombre || !correo) return null;

    const horas = Array.isArray(raw.openingHours) ? raw.openingHours : [];
    // Un horario con dos tramos ("10 AM to 2 PM, 5 to 9 PM") es servicio de
    // comidas y cenas, que es la señal más fiable de que hay equipo de sala.
    const partido = horas.some((h: { hours?: string }) =>
      (h?.hours ?? "").includes(","),
    );
    const abiertos = horas.filter(
      (h: { hours?: string }) => (h?.hours ?? "").toLowerCase() !== "cerrado",
    ).length;

    return {
      fullName: nombre,
      senales: [
        raw.reviewsCount
          ? `${raw.reviewsCount} reseñas en Google`
          : "sin reseñas",
        raw.totalScore ? `nota ${raw.totalScore}` : "",
        Array.isArray(raw.categories) && raw.categories.length
          ? `categorías: ${raw.categories.slice(0, 4).join(", ")}`
          : "",
        horas.length
          ? `abre ${abiertos} días/semana${partido ? ", horario partido" : ""}`
          : "",
        raw.website ? `web propia: ${raw.website}` : "sin web",
        Array.isArray(raw.instagrams) && raw.instagrams.length
          ? "tiene Instagram"
          : "",
        Array.isArray(raw.emails) && raw.emails.length > 3
          ? `${raw.emails.length} correos distintos en su web (indicio de plantilla)`
          : "",
        raw.claimThisBusiness === false ? "ficha reclamada por el negocio" : "",
        raw.permanentlyClosed ? "CERRADO PERMANENTEMENTE" : "",
      ].filter((x): x is string => Boolean(x)),
      headline: texto(raw.categoryName, raw.category, raw.subTitle),
      company: nombre,
      location: texto(raw.city, raw.address, raw.neighborhood),
      linkedinUrl: texto(
        Array.isArray(raw.linkedIns) ? raw.linkedIns[0] : null,
      ),
      // Maps devuelve las redes que encuentra en la web del negocio. Guardar el
      // usuario permite que un mismo hallazgo sirva para escribir por correo o
      // por Instagram, en vez de pagar dos búsquedas distintas.
      instagramUsername: usuarioDeUrlInstagram(
        Array.isArray(raw.instagrams) ? raw.instagrams[0] : null,
      ),
      email: correo,
      // El placeId es estable entre ejecuciones; la URL de Maps no siempre.
      providerId: texto(raw.placeId, raw.fid, raw.cid),
      raw: item,
    };
  }

  const usuario = texto(raw.username, raw.ownerUsername, raw.userName);
  if (!usuario) return null;

  /**
   * El actor de Instagram devuelve filas de error para los perfiles que no pudo
   * leer: `{error, errorDescription, url, username}` y nada más. Se colaban como
   * candidatos con solo el nombre de usuario, se pagaba por puntuarlos y el
   * modelo los tumbaba por falta de datos. No son candidatos: son fallos.
   */
  if (raw.error) return null;
  return {
    fullName: texto(raw.fullName, raw.name, raw.ownerFullName) ?? usuario,
    senales: [
      raw.followersCount ? `${raw.followersCount} seguidores` : "",
      raw.postsCount ? `${raw.postsCount} publicaciones` : "",
      raw.verified ? "cuenta verificada" : "",
      raw.isBusinessAccount ? "cuenta de empresa" : "",
      texto(raw.externalUrl, raw.website)
        ? `web: ${texto(raw.externalUrl, raw.website)}`
        : "sin web",
    ].filter((x): x is string => Boolean(x)),
    headline: texto(raw.biography, raw.bio),
    company: texto(raw.businessCategoryName, raw.categoryName),
    location: texto(raw.city, raw.locationName),
    linkedinUrl: null,
    instagramUsername: usuario,
    email: texto(raw.publicEmail, raw.email),
    providerId: texto(raw.id, raw.pk),
    raw: item,
  };
}

/* -------------------------------------------------------------------------- */
/* 3. Puntuación contra el ICP                                                 */
/* -------------------------------------------------------------------------- */

export type Puntuacion = {
  indice: number;
  score: number;
  verdict: "encaja" | "dudoso" | "no_encaja";
  reasoning: string;
};

const SCHEMA_PUNTUACION = {
  type: "object",
  additionalProperties: false,
  properties: {
    resultados: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          indice: {
            type: "integer",
            description: "El número que acompaña al candidato.",
          },
          score: {
            type: "integer",
            description: "Encaje con el ICP, de 0 a 100.",
          },
          verdict: { type: "string", enum: ["encaja", "dudoso", "no_encaja"] },
          reasoning: {
            type: "string",
            description: "Una frase. Qué señal concreta del perfil lo decide.",
          },
        },
        required: ["indice", "score", "verdict", "reasoning"],
      },
    },
  },
  required: ["resultados"],
} as const;

/** Lotes: puntuar de uno en uno multiplica el coste y la latencia sin mejorar nada. */
const TAMANO_LOTE = 12;

export async function puntuarCandidatos(
  icp: IcpParaProspeccion,
  candidatos: CandidatoNormalizado[],
  modelo: string,
): Promise<{ puntuaciones: Map<number, Puntuacion>; costeUsd: number }> {
  const puntuaciones = new Map<number, Puntuacion>();
  let costeUsd = 0;

  for (let inicio = 0; inicio < candidatos.length; inicio += TAMANO_LOTE) {
    const lote = candidatos.slice(inicio, inicio + TAMANO_LOTE);
    const listado = lote
      .map((c, i) =>
        [
          `### Candidato ${inicio + i}`,
          `Nombre: ${c.fullName}`,
          c.headline ? `Titular: ${c.headline}` : "",
          c.company ? `Empresa: ${c.company}` : "",
          c.location ? `Ubicación: ${c.location}` : "",
          c.senales.length ? `Señales: ${c.senales.join(" · ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n");

    const { data, usage } = await chatJson<{ resultados: Puntuacion[] }>({
      model: modelo,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "Puntúas candidatos contra un perfil de cliente ideal. Devuelves un resultado por candidato, con su índice.",
            "",
            "Un descalificador del ICP fuerza no_encaja y score por debajo de 20, por muy bien que encaje en lo demás.",
            "Esa es la única razón para descartar a alguien.",
            "",
            "QUE FALTE UN DATO NO ES UNA RAZÓN PARA DESCARTAR. Puntúa con lo que hay delante: si lo que",
            'ves encaja y nada lo contradice, eso es un encaje. Reserva "dudoso" para cuando haya señales',
            "CONTRADICTORIAS, no para cuando falte información. Ninguna de estas fuentes dice cuántos",
            "empleados tiene un negocio ni cuánto factura; si esperas ese dato, rechazarás a todo el mundo.",
            "",
            'Y "Señales" ES información: úsala. Un local con muchas reseñas, horario partido y web propia',
            "cumple los indicios de tamaño aunque nadie diga cuántos empleados tiene.",
            "",
            "Calíbrate contra la amplitud del ICP. Si el ICP es amplio, la mayoría de los candidatos de una",
            "búsqueda bien dirigida deberían encajar: estar rechazando a casi todos significa que el criterio",
            "está mal, no ellos. Si el ICP es estrecho, sé exigente. Lo dice el ICP, no tú.",
          ].join("\n"),
        },
        { role: "user", content: `${describirIcp(icp)}\n\n---\n\n${listado}` },
      ],
      jsonSchema: {
        name: "puntuaciones",
        schema: SCHEMA_PUNTUACION as unknown as Record<string, unknown>,
      },
    });

    costeUsd += usage.cost ?? 0;
    for (const r of data.resultados) {
      // Se recorta en vez de confiar: el CHECK de la base rechazaría un 140.
      puntuaciones.set(r.indice, {
        ...r,
        score: Math.max(0, Math.min(100, r.score)),
      });
    }
  }

  return { puntuaciones, costeUsd };
}
