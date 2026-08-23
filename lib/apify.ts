/**
 * Cliente de Apify.
 *
 * Regla de diseño: NUNCA se espera a que termine un run dentro de una petición.
 * Un scraping de perfiles tarda entre uno y diez minutos y una Vercel Function
 * tiene 300 s por defecto (techo duro en Hobby). Así que se arranca el run, se
 * guarda el runId en Neon y se sondea. El endpoint responde en milisegundos y
 * ningún timeout entra en juego.
 */

const BASE = 'https://api.apify.com/v2'

export class ApifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApifyError'
  }
}

function token(): string {
  const t = process.env.APIFY_TOKEN
  if (!t) throw new Error('APIFY_TOKEN no está definida.')
  return t
}

/** La API usa "usuario~actor" en la ruta, no "usuario/actor". */
function actorPath(actor: string): string {
  return encodeURIComponent(actor.replace('/', '~'))
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    cache: 'no-store',
  })
  const text = await res.text()
  if (!res.ok) {
    throw new ApifyError(`Apify respondió ${res.status}: ${text.slice(0, 300)}`, res.status)
  }
  return (text ? JSON.parse(text) : {}) as T
}

export type RunStatus =
  | 'READY'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'ABORTING'
  | 'ABORTED'
  | 'TIMING-OUT'
  | 'TIMED-OUT'

export type ApifyRun = {
  id: string
  status: RunStatus
  defaultDatasetId: string
  startedAt: string
  finishedAt: string | null
  /** Coste del run en USD, si Apify ya lo ha calculado. */
  costUsd: number | null
  statusMessage: string | null
}

type RawRun = {
  data: {
    id: string
    status: RunStatus
    defaultDatasetId: string
    startedAt: string
    finishedAt: string | null
    statusMessage?: string | null
    usageTotalUsd?: number
  }
}

function toRun(raw: RawRun): ApifyRun {
  const d = raw.data
  return {
    id: d.id,
    status: d.status,
    defaultDatasetId: d.defaultDatasetId,
    startedAt: d.startedAt,
    finishedAt: d.finishedAt,
    costUsd: typeof d.usageTotalUsd === 'number' ? d.usageTotalUsd : null,
    statusMessage: d.statusMessage ?? null,
  }
}

/**
 * Arranca un run y vuelve de inmediato, sin esperar al resultado.
 *
 * `maxItems` es la única barrera real contra una factura sorpresa: sin él, un
 * filtro mal traducido por el LLM puede sacar decenas de miles de perfiles.
 */
export async function startRun(
  actor: string,
  input: Record<string, unknown>,
  opts: { maxItems?: number; timeoutSecs?: number } = {},
): Promise<ApifyRun> {
  const params = new URLSearchParams()
  if (opts.maxItems) params.set('maxItems', String(opts.maxItems))
  params.set('timeout', String(opts.timeoutSecs ?? 900))
  const qs = params.toString()

  const raw = await call<RawRun>(`/acts/${actorPath(actor)}/runs?${qs}`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return toRun(raw)
}

export async function getRun(runId: string): Promise<ApifyRun> {
  return toRun(await call<RawRun>(`/actor-runs/${encodeURIComponent(runId)}`))
}

export async function abortRun(runId: string): Promise<ApifyRun> {
  return toRun(await call<RawRun>(`/actor-runs/${encodeURIComponent(runId)}/abort`, { method: 'POST' }))
}

export async function getDatasetItems<T = Record<string, unknown>>(
  datasetId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<T[]> {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 1000),
    offset: String(opts.offset ?? 0),
    clean: 'true',
  })
  return call<T[]>(`/datasets/${encodeURIComponent(datasetId)}/items?${params}`)
}

export function isFinished(status: RunStatus): boolean {
  return status !== 'READY' && status !== 'RUNNING'
}

/* -------------------------------------------------------------------------- */
/* Actores soportados                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Solo se permiten actores de esta lista.
 *
 * Es a propósito: el LLM traduce el ICP a los FILTROS del actor, pero no elige
 * el actor ni puede inventarse uno. Un identificador de actor generado por un
 * modelo es una llamada arbitraria a la API con la factura del usuario detrás.
 */
export const SUPPORTED_ACTORS = {
  linkedin: {
    actor: 'harvestapi/linkedin-profile-search',
    label: 'Búsqueda de perfiles de LinkedIn',
    /** Sin cookies ni cuenta: no arriesga la cuenta de LinkedIn del usuario. */
    note: 'Filtros de cargo, sector, tamaño de empresa y ubicación. No necesita cookies.',
  },
  instagram: {
    actor: 'apify/instagram-scraper',
    label: 'Búsqueda en Instagram',
    note: 'Busca por hashtag o por palabra clave y devuelve los perfiles que publican.',
  },
} as const satisfies Record<string, { actor: string; label: string; note: string }>

export type ProspectSource = keyof typeof SUPPORTED_ACTORS
