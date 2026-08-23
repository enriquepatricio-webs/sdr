/**
 * Cliente de OpenRouter.
 *
 * Dos cosas que conviene saber y que condicionan este fichero:
 *
 * 1. `usage.cost` viene ya en TODA respuesta y es el importe REALMENTE cobrado.
 *    Los parámetros `usage:{include:true}` y `stream_options:{include_usage:true}`
 *    están deprecados y no hacen nada. Así que el coste del panel no es una
 *    estimación a partir de tokens: es el número que cobra OpenRouter.
 *
 * 2. GET /models es público y no necesita API key, así que el selector de modelo
 *    del dashboard puede poblarse sin exponer OPENROUTER_API_KEY al navegador.
 */

const BASE = 'https://openrouter.ai/api/v1'

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export type ChatMessage = {
  role: ChatRole
  content: string
  tool_call_id?: string
  name?: string
}

export type Usage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  /** Importe real cargado, en USD. Es lo que se guarda en run_logs. */
  cost?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export type ChatResult = {
  /** Id de generación. Sirve para auditar el coste luego en /generation. */
  id: string
  text: string
  usage: Usage
  model: string
  finishReason: string | null
  /** Milisegundos de reloj, medidos aquí. */
  latencyMs: number
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'OpenRouterError'
  }
}

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY no está definida.')
  return key
}

/**
 * HTTP-Referer y X-OpenRouter-Title solo sirven para la atribución de la app en
 * los rankings de OpenRouter. No afectan a la inferencia, pero sin HTTP-Referer
 * no se agrega el consumo bajo una sola app.
 */
function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
    'X-OpenRouter-Title': 'SDR autónomo',
  }
}

export type ChatOptions = {
  model: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /**
   * Fuerza una respuesta que valide contra este JSON Schema. OpenRouter enruta
   * solo a proveedores que lo soporten porque se añade provider.require_parameters:
   * el soporte de structured outputs se decide por endpoint, no por modelo.
   */
  jsonSchema?: { name: string; schema: Record<string, unknown> }
  signal?: AbortSignal
}

export async function chat(options: ChatOptions): Promise<ChatResult> {
  const startedAt = Date.now()

  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: options.jsonSchema.name, strict: true, schema: options.jsonSchema.schema },
    }
    body.provider = { require_parameters: true }
  }

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: options.signal,
  })

  const raw = await res.text()
  if (!res.ok) {
    throw new OpenRouterError(
      `OpenRouter respondió ${res.status}: ${raw.slice(0, 400)}`,
      res.status,
      raw,
    )
  }

  let parsed: {
    id: string
    model: string
    choices?: { message?: { content?: string }; finish_reason?: string }[]
    usage?: Usage
    error?: { message?: string }
  }
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new OpenRouterError('OpenRouter devolvió algo que no es JSON', res.status, raw)
  }

  // Un 200 con `error` dentro ocurre cuando falla el proveedor de destino.
  if (parsed.error) {
    throw new OpenRouterError(
      `OpenRouter devolvió error en un 200: ${parsed.error.message ?? 'sin mensaje'}`,
      res.status,
      raw,
    )
  }

  const choice = parsed.choices?.[0]
  return {
    id: parsed.id,
    text: choice?.message?.content ?? '',
    model: parsed.model,
    finishReason: choice?.finish_reason ?? null,
    usage: parsed.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    latencyMs: Date.now() - startedAt,
  }
}

/** Igual que `chat` pero devuelve el JSON ya parseado y tipado. */
export async function chatJson<T>(
  options: ChatOptions & { jsonSchema: NonNullable<ChatOptions['jsonSchema']> },
): Promise<{ data: T; usage: Usage; id: string }> {
  const result = await chat(options)
  try {
    return { data: JSON.parse(result.text) as T, usage: result.usage, id: result.id }
  } catch {
    throw new OpenRouterError(
      `El modelo no devolvió JSON válido pese al schema estricto: ${result.text.slice(0, 300)}`,
      200,
      result.text,
    )
  }
}

export type ModelInfo = {
  id: string
  name: string
  contextLength: number
  /** USD por millón de tokens, ya convertido desde el precio por token. */
  promptPerMillion: number
  completionPerMillion: number
  supportsTools: boolean
  supportsStructuredOutputs: boolean
}

type RawModel = {
  id: string
  name: string
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
  supported_parameters?: string[]
}

/**
 * Lista de modelos con precios. Endpoint público: no manda la API key.
 *
 * Los precios llegan como cadenas en USD POR TOKEN; se multiplican por 1e6 para
 * que el dashboard muestre $/M, que es como se razona sobre coste.
 */
export async function listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
  const res = await fetch(`${BASE}/models`, {
    signal,
    // El catálogo rota, pero no tanto como para pedirlo en cada pintado.
    next: { revalidate: 60 * 60 * 6 },
  })
  if (!res.ok) {
    throw new OpenRouterError(`No se pudo listar modelos (${res.status})`, res.status, '')
  }
  const json = (await res.json()) as { data?: RawModel[] }
  return (json.data ?? [])
    .map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.context_length ?? 0,
      promptPerMillion: Number(m.pricing?.prompt ?? 0) * 1e6,
      completionPerMillion: Number(m.pricing?.completion ?? 0) * 1e6,
      supportsTools: m.supported_parameters?.includes('tools') ?? false,
      supportsStructuredOutputs: m.supported_parameters?.includes('structured_outputs') ?? false,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Estimación de tokens para el contador del editor de playbook.
 *
 * Deliberadamente aproximada: contar de verdad exigiría el tokenizador de cada
 * modelo. ~3,6 caracteres por token va bien para castellano; el contador solo
 * tiene que avisar de que un prompt se está yendo de las manos.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6)
}
