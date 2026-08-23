/**
 * Aprender de los resultados propios.
 *
 * Esto NO reentrena ningún modelo. Lo que hace es mirar qué mensajes acabaron
 * en respuesta y cuáles murieron, pedirle al modelo que destile la diferencia
 * en frases concretas, y meter esas frases en el prompt del agente. El bucle se
 * cierra con datos reales, no con impresiones.
 *
 * Regla dura: sin volumen no hay lección. Con cuatro mensajes enviados, la
 * diferencia entre los que funcionaron y los que no es ruido, y destilar ruido
 * produce reglas con mucha seguridad y ningún fundamento, que es peor que no
 * tener nada.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { db } from './db'
import { type Lecciones, leads, meetings, touches } from './db/schema'
import { chatJson } from './openrouter'

/** Por debajo de esto no se destila nada. */
export const MINIMO_PARA_APRENDER = 30

export type Resultados = {
  enviados: number
  respondidos: number
  reuniones: number
  tasaRespuesta: number
  tasaReunion: number
}

export async function calcularResultados(desde: Date): Promise<Resultados> {
  const [fila] = await db
    .select({
      enviados: sql<number>`count(*) filter (where ${touches.direction} = 'out' and ${touches.status} = 'enviado')::int`,
      respondidos: sql<number>`count(distinct ${touches.leadId}) filter (where ${touches.direction} = 'in')::int`,
    })
    .from(touches)
    .where(gte(touches.createdAt, desde))

  const [reu] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(meetings)
    .where(gte(meetings.createdAt, desde))

  const enviados = Number(fila?.enviados ?? 0)
  const respondidos = Number(fila?.respondidos ?? 0)
  const reuniones = Number(reu?.n ?? 0)

  return {
    enviados,
    respondidos,
    reuniones,
    tasaRespuesta: enviados ? respondidos / enviados : 0,
    tasaReunion: respondidos ? reuniones / respondidos : 0,
  }
}

export type Muestra = { texto: string; resultado: 'respondio' | 'silencio'; acaboEnReunion: boolean }

/**
 * Primeros toques enviados, con lo que pasó después.
 *
 * Solo el primer toque: es el único momento comparable entre leads. Comparar un
 * cuarto seguimiento con una apertura no dice nada sobre la apertura.
 */
export async function obtenerMuestras(limite = 200): Promise<Muestra[]> {
  const filas = await db
    .select({
      texto: touches.body,
      leadId: touches.leadId,
      status: leads.status,
      respuestas: sql<number>`(
        select count(*) from ${touches} t2
        where t2.lead_id = ${touches.leadId} and t2.direction = 'in'
      )::int`,
      reunion: sql<number>`(
        select count(*) from ${meetings} m where m.lead_id = ${touches.leadId}
      )::int`,
    })
    .from(touches)
    .innerJoin(leads, eq(touches.leadId, leads.id))
    .where(
      and(eq(touches.direction, 'out'), eq(touches.status, 'enviado'), eq(touches.step, 1)),
    )
    .orderBy(desc(touches.sentAt))
    .limit(limite)

  return filas.map((f) => ({
    texto: f.texto,
    resultado: Number(f.respuestas) > 0 ? 'respondio' : 'silencio',
    acaboEnReunion: Number(f.reunion) > 0,
  }))
}

const SCHEMA_LECCIONES = {
  type: 'object',
  additionalProperties: false,
  properties: {
    funciona: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Como mucho 5 frases. Cada una, una pauta concreta y accionable sacada de los mensajes que SÍ obtuvieron respuesta. Nada de generalidades tipo "ser personal".',
    },
    noFunciona: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Como mucho 5 frases. Patrones concretos presentes en los mensajes que murieron en silencio y ausentes en los que funcionaron.',
    },
  },
  required: ['funciona', 'noFunciona'],
} as const

export type ResultadoAprendizaje =
  | { aprendio: false; motivo: 'sin_datos'; enviados: number; hacenFalta: number }
  | { aprendio: true; lecciones: Lecciones; costeUsd: number }

/**
 * Destila lecciones comparando lo que funcionó con lo que no.
 *
 * Se le pasan los dos grupos etiquetados y se le pide la DIFERENCIA. Pedirle
 * "consejos de ventas" a secas devolvería lo que ya sabe de su entrenamiento,
 * no lo que funciona con estos prospectos concretos.
 */
export async function destilarLecciones(modelo: string): Promise<ResultadoAprendizaje> {
  const muestras = await obtenerMuestras()

  if (muestras.length < MINIMO_PARA_APRENDER) {
    return {
      aprendio: false,
      motivo: 'sin_datos',
      enviados: muestras.length,
      hacenFalta: MINIMO_PARA_APRENDER - muestras.length,
    }
  }

  const ganadores = muestras.filter((m) => m.resultado === 'respondio')
  const perdedores = muestras.filter((m) => m.resultado === 'silencio')

  // Si todo cayó del mismo lado no hay contraste que analizar.
  if (!ganadores.length || !perdedores.length) {
    return {
      aprendio: false,
      motivo: 'sin_datos',
      enviados: muestras.length,
      hacenFalta: 0,
    }
  }

  const { data, usage } = await chatJson<{ funciona: string[]; noFunciona: string[] }>({
    model: modelo,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: [
          'Analizas mensajes de prospección en frío ya enviados, etiquetados por resultado.',
          '',
          'Tu trabajo es encontrar la DIFERENCIA entre los que obtuvieron respuesta y los que',
          'murieron en silencio. No des consejos generales de ventas: solo lo que se observa',
          'en estos textos concretos.',
          '',
          'Si un patrón aparece igual en los dos grupos, NO es una lección: descártalo.',
          'Prefiere pocas frases y sólidas a muchas y vagas.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `OBTUVIERON RESPUESTA (${ganadores.length}):`,
          ...ganadores.slice(0, 40).map((m, i) => `${i + 1}. ${m.texto}`),
          '',
          `SILENCIO (${perdedores.length}):`,
          ...perdedores.slice(0, 40).map((m, i) => `${i + 1}. ${m.texto}`),
        ].join('\n'),
      },
    ],
    jsonSchema: { name: 'lecciones', schema: SCHEMA_LECCIONES as unknown as Record<string, unknown> },
  })

  return {
    aprendio: true,
    costeUsd: usage.cost ?? 0,
    lecciones: {
      funciona: data.funciona.slice(0, 5),
      noFunciona: data.noFunciona.slice(0, 5),
      basadoEn: muestras.length,
      actualizado: new Date().toISOString(),
    },
  }
}
