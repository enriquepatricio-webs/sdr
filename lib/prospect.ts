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
    searchQuery: {
      type: "string",
      description:
        'Búsqueda difusa en castellano o inglés. Ej: "fundador consultoría B2B".',
    },
    currentJobTitles: {
      type: "array",
      items: { type: "string" },
      description: 'Cargos actuales exactos. Ej: ["Founder","CEO","Socio"].',
    },
    locations: {
      type: "array",
      items: { type: "string" },
      description:
        'Ubicaciones tal y como las entiende LinkedIn. Usa el nombre completo del país: "Spain", no "ES".',
    },
    companyHeadcount: {
      type: "array",
      items: {
        type: "string",
        enum: ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
      },
      description:
        "Tamaño de empresa: A=autónomo, B=1-10, C=11-50, D=51-200, E=201-500, F=501-1000, G=1001-5000, H=5001-10000, I=10001+.",
    },
    seniorityLevelIds: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "100",
          "110",
          "120",
          "130",
          "200",
          "210",
          "220",
          "300",
          "310",
          "320",
        ],
      },
      description:
        "Seniority: 120=Senior, 220=Director, 300=VP, 310=CXO, 320=Owner/Partner. Para decisores usa 310 y 320.",
    },
    excludeCurrentJobTitles: {
      type: "array",
      items: { type: "string" },
      description:
        "Cargos que descartan. Sale de los descalificadores del ICP.",
    },
    profileLanguages: {
      type: "array",
      items: {
        type: "string",
        enum: ["Spanish", "English", "Portuguese", "French", "Italian"],
      },
      description: "Idioma del perfil.",
    },
    razonamiento: {
      type: "string",
      description:
        "Por qué estos filtros y no otros, en dos frases. Es lo que se lee cuando la búsqueda sale mal.",
    },
    angulo: {
      type: "string",
      description:
        'Etiqueta corta de este ángulo de búsqueda, máximo ocho palabras. Ej: "consultoras de RRHH en Valencia".',
    },
  },
  required: ["searchQuery", "razonamiento", "angulo"],
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
  instagram: SCHEMA_INSTAGRAM,
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
/** Valores que el actor de LinkedIn acepta. Fuera de esta lista devuelve un 400. */
const SENIORITY_VALIDOS = [
  "100",
  "110",
  "120",
  "130",
  "200",
  "210",
  "220",
  "300",
  "310",
  "320",
];
const HEADCOUNT_VALIDOS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];

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
    const { seniorityLevelIds, companyHeadcount, ...resto } = filtros;
    const seniority = soloValores(seniorityLevelIds, SENIORITY_VALIDOS);
    const plantilla = soloValores(companyHeadcount, HEADCOUNT_VALIDOS);
    return {
      ...resto,
      ...(seniority ? { seniorityLevelIds: seniority } : {}),
      ...(plantilla ? { companyHeadcount: plantilla } : {}),
      maxItems,
      profileScraperMode: "Short",
    };
  }
  if (fuente === "instagram") {
    return { ...filtros, resultsType: "details", searchLimit: maxItems };
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
    const nombre =
      texto(raw.name, raw.fullName, raw.full_name) ??
      texto([raw.firstName, raw.lastName].filter(Boolean).join(" "));
    const url = texto(raw.linkedinUrl, raw.profileUrl, raw.url, raw.publicUrl);
    const identificador = texto(raw.publicIdentifier, raw.public_identifier);
    if (!nombre || !(url || identificador)) return null;

    return {
      fullName: nombre,
      senales: [
        raw.connectionsCount ? `${raw.connectionsCount} contactos` : "",
        raw.followerCount ? `${raw.followerCount} seguidores` : "",
        texto(raw.currentPosition?.[0]?.companyIndustry, raw.industry),
        raw.currentPosition?.[0]?.companyStaffCountRange
          ? `plantilla ${raw.currentPosition[0].companyStaffCountRange}`
          : "",
      ].filter((x): x is string => Boolean(x)),
      headline: texto(raw.headline, raw.title, raw.occupation),
      company: texto(
        raw.currentPosition?.[0]?.companyName,
        raw.currentCompany?.name,
        raw.companyName,
        raw.company,
      ),
      location: texto(
        raw.location?.linkedinText,
        raw.location?.parsed?.text,
        raw.location,
        raw.geo,
      ),
      linkedinUrl: url ?? `https://www.linkedin.com/in/${identificador}`,
      instagramUsername: null,
      email: texto(raw.email, raw.emailAddress),
      providerId: texto(raw.id, raw.profileId, raw.urn),
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
            'Si el perfil no da información suficiente para decidir, es "dudoso": no lo apruebes por si acaso.',
            'Pero "Señales" ES información: úsala. Un local con muchas reseñas, horario partido y web propia',
            "cumple los indicios de tamaño aunque nadie diga cuántos empleados tiene. No pidas un dato que",
            "esta fuente nunca da; decide con los indicios que el propio ICP te indica cómo leer.",
            "Sé duro. Estos candidatos van a recibir un mensaje de una persona real.",
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
