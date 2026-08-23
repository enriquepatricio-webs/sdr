/**
 * Ajustes del sistema. Viven en la tabla `settings` (clave/valor jsonb) para
 * poder cambiarlos desde el dashboard sin redesplegar.
 */
import { inArray } from 'drizzle-orm'
import { db } from './db'
import { type Lecciones, settings } from './db/schema'

export type Settings = {
  /** OFF por defecto. Con esto apagado el agente redacta pero no envía. */
  autopilot: boolean
  openrouterModel: string
  telegramChatId: string
  companyName: string
  /**
   * Reabastecimiento automático: cuando una campaña se queda sin leads, el
   * sistema busca más él solo en vez de pararse.
   *
   * Arranca APAGADO. Encenderlo es el "yo se lo digo": a partir de ahí no para
   * hasta que lo apagues. Gasta dinero de Apify y del modelo por su cuenta, así
   * que no puede activarse por defecto.
   */
  autoProspect: boolean
  /** Por debajo de estos leads pendientes, la campaña pide más. */
  autoProspectMinLeads: number
  /** Freno de gasto: búsquedas automáticas como mucho al día, en todo el sistema. */
  autoProspectMaxSearchesPerDay: number
  /** Perfiles por búsqueda. */
  autoProspectMaxItems: number
  /** Score de ICP a partir del cual un candidato entra solo en la campaña. */
  autoProspectMinScore: number
  /** Enriquecer el perfil y la web del prospecto antes de escribirle. */
  enrichBeforeContact: boolean
  /** Lo destilado de los resultados reales. null hasta que haya volumen. */
  lessons: Lecciones | null
}

/**
 * Verificado contra GET https://openrouter.ai/api/v1/models: existe, admite
 * tools y structured outputs. Se cambia desde /settings sin tocar código.
 */
export const DEFAULT_SETTINGS: Settings = {
  autopilot: false,
  openrouterModel: 'anthropic/claude-sonnet-5',
  telegramChatId: '',
  companyName: 'Tu Empresa',
  autoProspect: false,
  autoProspectMinLeads: 20,
  autoProspectMaxSearchesPerDay: 4,
  autoProspectMaxItems: 50,
  autoProspectMinScore: 70,
  enrichBeforeContact: true,
  lessons: null,
}

const KEYS = {
  autopilot: 'autopilot',
  openrouterModel: 'openrouter_model',
  telegramChatId: 'telegram_chat_id',
  companyName: 'company_name',
  autoProspect: 'auto_prospect',
  autoProspectMinLeads: 'auto_prospect_min_leads',
  autoProspectMaxSearchesPerDay: 'auto_prospect_max_searches_per_day',
  autoProspectMaxItems: 'auto_prospect_max_items',
  autoProspectMinScore: 'auto_prospect_min_score',
  enrichBeforeContact: 'enrich_before_contact',
  lessons: 'lessons',
} as const satisfies Record<keyof Settings, string>

export async function getSettings(): Promise<Settings> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, Object.values(KEYS)))

  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const read = <K extends keyof Settings>(field: K): Settings[K] => {
    const raw = byKey.get(KEYS[field])
    return raw === undefined || raw === null || raw === ''
      ? DEFAULT_SETTINGS[field]
      : (raw as Settings[K])
  }

  return {
    autopilot: read('autopilot') === true,
    openrouterModel: String(read('openrouterModel')),
    // La tabla manda sobre el entorno; si está vacía, se cae al env.
    telegramChatId: String(read('telegramChatId') || process.env.TELEGRAM_CHAT_ID || ''),
    companyName: String(read('companyName')),
    autoProspect: read('autoProspect') === true,
    autoProspectMinLeads: Number(read('autoProspectMinLeads')),
    autoProspectMaxSearchesPerDay: Number(read('autoProspectMaxSearchesPerDay')),
    autoProspectMaxItems: Number(read('autoProspectMaxItems')),
    autoProspectMinScore: Number(read('autoProspectMinScore')),
    enrichBeforeContact: read('enrichBeforeContact') !== false,
    lessons: (byKey.get(KEYS.lessons) as Lecciones | null) ?? null,
  }
}

export async function setSetting<K extends keyof Settings>(
  field: K,
  value: Settings[K],
): Promise<void> {
  await db
    .insert(settings)
    .values({ key: KEYS[field], value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
}
