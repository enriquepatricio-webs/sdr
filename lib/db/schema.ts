import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  primaryKey,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/* -------------------------------------------------------------------------- */
/* Tipos de los campos jsonb                                                   */
/* -------------------------------------------------------------------------- */

/** Señal del ICP. `signal` es lo que el agente debe buscar en el perfil/raw. */
export type IcpSignal = {
  id: string
  signal: string
  /** Dónde suele verse: headline, empresa, web, actividad reciente... */
  source?: string
}

export type QualificationCriterion = {
  id: string
  /** Pregunta que el agente debe resolver, no necesariamente preguntar. */
  question: string
  /** Peso sobre 100. La suma de todos los criterios debería dar 100. */
  weight: number
  /** Cómo inferirlo sin preguntar, para gastar las 2 preguntas disponibles bien. */
  inferable_from?: string
}

export type Objection = { objection: string; response: string }

/** Lo que sabemos del prospecto antes de escribirle. */
export type Enrichment = {
  /** Resumen listo para meter en el prompt. */
  resumen: string
  /** Texto crudo del perfil, si se pudo sacar. */
  perfil?: string
  /** Texto crudo de la web de su empresa. */
  web?: string
  /** De dónde salió cada cosa, para poder auditarlo. */
  fuentes: string[]
  costeUsd?: number
}

/**
 * Lo que el sistema ha aprendido de sus propios resultados.
 *
 * NO son pesos de un modelo: son frases destiladas de datos reales
 * (qué aperturas obtuvieron respuesta, cuáles no) que se inyectan en el prompt.
 */
export type Lecciones = {
  funciona: string[]
  noFunciona: string[]
  /** Sobre cuántos mensajes se calculó. Sin volumen, no hay lección. */
  basadoEn: number
  actualizado: string
}

export type BookingRules = {
  /** Duración de la reunión en minutos. */
  duration_min: number
  /** Antelación mínima entre "ahora" y el hueco propuesto. */
  min_notice_hours: number
  /** Colchón antes y después de cada reunión. */
  buffer_min: number
  /** Cuántos días vista mira el agente al buscar huecos. */
  lookahead_days: number
  timezone: string
  working_hours: { from: string; to: string; days: number[] }
  /** Umbral duro: por debajo de esto el agente no puede agendar. */
  min_score_to_book: number
  /** Cuántos huecos ofrece de golpe. Más de 3 satura. */
  max_slots_offered: number
}

export type SendingWindow = { tz: string; from: string; to: string; days: number[] }

export type QualificationAnswer = {
  criterion_id: string
  answer: string
  met: boolean
}

/** Lo que escribe la tool `registrar_cualificacion`. */
export type Qualification = {
  score: number
  verdict: 'cualificado' | 'descartado' | 'pendiente'
  reasoning: string
  /** Resumen de una línea, es lo que sale en el aviso de Telegram. */
  summary?: string
  answers?: QualificationAnswer[]
  disqualified_by?: string
  evaluated_at?: string
}

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Sirve a la vez de proveedor de cuenta y de canal de campaña/toque.
 * Los tres los cubre Unipile (LINKEDIN, INSTAGRAM, GOOGLE/IMAP para email).
 */
export const channelEnum = pgEnum('channel', ['linkedin', 'email', 'instagram'])

export type Channel = (typeof channelEnum.enumValues)[number]

export const accountStatusEnum = pgEnum('account_status', ['active', 'paused', 'disconnected'])

export const campaignStatusEnum = pgEnum('campaign_status', ['draft', 'running', 'paused', 'done'])

export const leadStatusEnum = pgEnum('lead_status', [
  'nuevo',
  'contactado',
  'en_seguimiento',
  'respondido',
  'cualificando',
  'cualificado',
  'descartado',
  'agendado',
  'no_interesado',
  'error',
  'revision_humana',
])

export const touchDirectionEnum = pgEnum('touch_direction', ['out', 'in'])

/**
 * Ciclo de vida de un mensaje saliente.
 *
 * `borrador`  el agente lo ha redactado y espera aprobación (autopiloto OFF),
 *             o está registrado justo antes de enviarlo (autopiloto ON).
 * `enviado`   el proveedor ha confirmado la entrega. Solo esto cuenta para el
 *             tope diario y para touch_count.
 * `fallido`   se registró y el envío falló. NO se reintenta desde aquí: podría
 *             duplicar el mensaje al prospecto. Lo resuelve un humano.
 *
 * Los mensajes entrantes nacen ya en `enviado`: existen, han ocurrido.
 */
export const touchStatusEnum = pgEnum('touch_status', ['borrador', 'enviado', 'fallido'])

export const meetingStatusEnum = pgEnum('meeting_status', [
  'booked',
  'cancelled',
  'completed',
  'no_show',
])

export const logLevelEnum = pgEnum('log_level', ['debug', 'info', 'warn', 'error'])

export type LeadStatus = (typeof leadStatusEnum.enumValues)[number]

/**
 * Estados en los que el agente ya no debe volver a tocar el lead.
 * `cualificado` NO es terminal: aún tiene que agendar.
 * `revision_humana` es terminal para el agente, no para el humano.
 */
export const TERMINAL_LEAD_STATUSES = [
  'descartado',
  'agendado',
  'no_interesado',
  'error',
  'revision_humana',
] as const satisfies readonly LeadStatus[]

/**
 * Los mismos estados terminales, en SQL. Se deriva de la constante de arriba
 * para que el predicado del índice parcial no pueda quedarse desincronizado:
 * si divergen, la cola de trabajo deja de poder usar el índice y pasa a hacer
 * seq scan de toda la tabla sin que nada avise.
 */
const TERMINAL_STATUSES_SQL = sql.raw(TERMINAL_LEAD_STATUSES.map((s) => `'${s}'`).join(','))

/**
 * Normalización de identidad para deduplicar leads.
 *
 * Vive en la base de datos y no en el importador a propósito: la garantía de
 * "no escribir dos veces a la misma persona" no puede depender de que quien
 * inserta se acuerde de normalizar. Debe ser IMMUTABLE para poder indexarse.
 */
export const normalizedEmail = (col: unknown) => sql`lower(${col})`
/** "@Ana", "ana" y "Ana " son el mismo usuario de Instagram. */
export const normalizedHandle = (col: unknown) => sql`lower(btrim(${col}, ' @'))`
export const normalizedLinkedinUrl = (col: unknown) =>
  // lower() PRIMERO: regexp_replace distingue mayúsculas, así que con el orden
  // inverso un "HTTPS://WWW." no casaba con el patrón y esa variante escapaba
  // a la deduplicación. Se descubrió ejecutando el test, no leyendo el código.
  sql`regexp_replace(lower(${col}), '^https?://(www\\.)?|/+$', '', 'g')`

/**
 * Tope duro de acciones/día por cuenta. Ni configurando se puede superar.
 *
 * Referencia de Unipile: LinkedIn admite 80-100 invitaciones/día en cuentas de
 * pago y ~100 acciones/día en general; Instagram, 100 acciones/día y no más de
 * 10 por hora. 80 se queda por debajo de ambos con margen.
 */
export const MAX_DAILY_LIMIT = 80
export const DEFAULT_DAILY_LIMIT = 25

/**
 * Tope por hora. Instagram lo exige de verdad: 100 al día repartidos en diez
 * minutos es exactamente el patrón que detecta el antifraude. `null` = sin
 * tope horario (LinkedIn y email no lo necesitan).
 */
export const MAX_HOURLY_LIMIT = 20
export const DEFAULT_HOURLY_LIMIT: Partial<Record<Channel, number>> = { instagram: 8 }

/* -------------------------------------------------------------------------- */
/* Tablas                                                                      */
/* -------------------------------------------------------------------------- */

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** A qué cliente pertenece. Una cuenta no puede servir a dos empresas. */
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'restrict' }),
    unipileAccountId: text('unipile_account_id').notNull(),
    provider: channelEnum('provider').notNull(),
    displayName: text('display_name').notNull(),
    dailyLimit: integer('daily_limit').notNull().default(DEFAULT_DAILY_LIMIT),
    /** null = sin tope horario. Obligatorio en la práctica para Instagram. */
    hourlyLimit: integer('hourly_limit'),
    status: accountStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_unipile_account_id_key').on(t.unipileAccountId),
    // Destino de la clave ajena compuesta de campaigns: ata canal con proveedor.
    unique('accounts_id_provider_key').on(t.id, t.provider),
    // Y esta ata la cuenta con su workspace, para que una campaña no pueda
    // enviar por la cuenta de otro cliente. Es un error de base de datos, no
    // un descuido que se descubre cuando el prospecto ya recibió el mensaje.
    unique('accounts_id_workspace_key').on(t.id, t.workspaceId),
    index('accounts_workspace_idx').on(t.workspaceId),
    check(
      'accounts_daily_limit_range',
      sql`${t.dailyLimit} > 0 AND ${t.dailyLimit} <= ${sql.raw(String(MAX_DAILY_LIMIT))}`,
    ),
    check(
      'accounts_hourly_limit_range',
      sql`${t.hourlyLimit} IS NULL OR (${t.hourlyLimit} > 0 AND ${t.hourlyLimit} <= ${sql.raw(String(MAX_HOURLY_LIMIT))})`,
    ),
    // Un tope horario mayor que el diario no significa nada.
    check(
      'accounts_hourly_below_daily',
      sql`${t.hourlyLimit} IS NULL OR ${t.hourlyLimit} <= ${t.dailyLimit}`,
    ),
  ],
)

export const icps = pgTable('icps', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  description: text('description'),
  /** Señales que SÍ cualifican. */
  criteria: jsonb('criteria').$type<IcpSignal[]>().notNull().default(sql`'[]'::jsonb`),
  /** Señales que descartan de inmediato, sin conversación. */
  disqualifiers: jsonb('disqualifiers').$type<IcpSignal[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})

/**
 * El entrenamiento de ventas del agente. Nunca se sobrescribe: al guardar se
 * crea una fila nueva con `version` incrementada y se decide cuál está activa.
 */
export const playbooks = pgTable(
  'playbooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * NULL = playbook por defecto, el que usan todos los workspaces que no
     * tengan uno propio. Es lo que hace que el método de venta venga puesto de
     * fábrica y nadie tenga que escribirlo para empezar.
     */
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    systemPrompt: text('system_prompt').notNull(),
    offer: text('offer').notNull(),
    qualificationCriteria: jsonb('qualification_criteria')
      .$type<QualificationCriterion[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    objections: jsonb('objections').$type<Objection[]>().notNull().default(sql`'[]'::jsonb`),
    bookingRules: jsonb('booking_rules').$type<BookingRules>().notNull(),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('playbooks_name_version_key').on(t.name, t.version),
    /**
     * Un activo por ámbito, no uno en todo el sistema. El índice antiguo
     * reventaba en cuanto un segundo cliente quisiera su propio playbook.
     */
    uniqueIndex('playbooks_activo_global')
      .on(t.isActive)
      .where(sql`${t.isActive} AND ${t.workspaceId} IS NULL`),
    uniqueIndex('playbooks_activo_por_workspace')
      .on(t.workspaceId)
      .where(sql`${t.isActive} AND ${t.workspaceId} IS NOT NULL`),
    index('playbooks_workspace_idx').on(t.workspaceId),
  ],
)

/**
 * Un workspace: la empresa para la que se vende.
 *
 * Existe aparte del playbook porque el playbook es el MÉTODO de venta y esto es
 * el CONTEXTO. El mismo método sirve para varios clientes; lo que cambia es qué
 * vende cada uno.
 *
 * La tabla se sigue llamando `workspaces` en la base de datos a propósito: ya tiene
 * datos y renombrarla obligaría a una migración destructiva por un nombre. En el
 * código se llama `workspaces`, que es lo que significa.
 *
 * Los ajustes que dependen del cliente viven aquí como columnas, no en la tabla
 * `settings`. Un `telegram_chat_id` global manda los avisos del cliente A al
 * chat del B, y un `autopilot` global enciende el envío de todos a la vez.
 */
export const workspaces = pgTable(
  // El nombre de la tabla NO cambia: ya tiene datos y renombrarla obligaría a
  // una migración destructiva por un nombre. En el código se llama `workspaces`,
  // que es lo que significa.
  'sellers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    website: text('website'),
    /** Lo que escribe el usuario a mano. Manda sobre lo scrapeado. */
    context: text('context'),
    /** Lo que se sacó de su web. Se regenera al pulsar "Leer mi web". */
    scrapedContext: text('scraped_context'),
    scrapedAt: timestamp('scraped_at', { withTimezone: true }),
    /** Oferta, garantía y condiciones. Sin cifras: no salen por mensaje. */
    offer: text('offer'),

    /* --- Ajustes por cliente ------------------------------------------- */
    /** Si el agente envía solo. Por workspace: encenderlo en uno no enciende los demás. */
    autopilot: boolean('autopilot').notNull().default(false),
    /** Cada cliente quiere sus avisos en su chat. */
    telegramChatId: text('telegram_chat_id'),
    /**
     * Lo aprendido de los resultados DE ESTE cliente. Compartirlo entre
     * empresas no es contexto: es ruido con aspecto de dato, y en el prompt
     * va con la coletilla de que pesa más que cualquier corazonada.
     */
    lessons: jsonb('lessons').$type<Lecciones>(),
    autoProspect: boolean('auto_prospect').notNull().default(false),
    autoProspectMinLeads: integer('auto_prospect_min_leads').notNull().default(20),
    autoProspectMaxItems: integer('auto_prospect_max_items').notNull().default(50),
    autoProspectMinScore: integer('auto_prospect_min_score').notNull().default(70),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('sellers_name_key').on(t.name),
    // Destino de la clave ajena compuesta de accounts.
    unique('workspaces_id_key').on(t.id),
  ],
)


export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    status: campaignStatusEnum('status').notNull().default('draft'),
    icpId: uuid('icp_id').references(() => icps.id, { onDelete: 'restrict' }),
    playbookId: uuid('playbook_id').references(() => playbooks.id, { onDelete: 'restrict' }),
    /** Para quién se vende en esta campaña. */
    workspaceId: uuid('seller_id').references(() => workspaces.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    channel: channelEnum('channel').notNull(),
    dailyCap: integer('daily_cap').notNull().default(DEFAULT_DAILY_LIMIT),
    sendingWindow: jsonb('sending_window').$type<SendingWindow>().notNull(),
    /** Días de espera entre toques: [3, 5, 7]. */
    followupDelays: jsonb('followup_delays').$type<number[]>().notNull().default(sql`'[3,5,7]'::jsonb`),
    maxTouches: integer('max_touches').notNull().default(4),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('campaigns_status_idx').on(t.status),
    /**
     * Una campaña de LinkedIn no puede colgar de una cuenta de email. Es clave
     * ajena compuesta y no un CHECK porque la coherencia cruza dos tablas.
     * Con account_id NULL (campaña en borrador) no se exige nada.
     */
    foreignKey({
      columns: [t.accountId, t.channel],
      foreignColumns: [accounts.id, accounts.provider],
      name: 'campaigns_account_channel_fk',
    }).onDelete('restrict'),
    /**
     * La cuenta tiene que ser del MISMO workspace que la campaña. Sin esto,
     * un descuido en un formulario manda mensajes de un cliente por la cuenta
     * de otro, y eso no se arregla pidiendo perdón.
     */
    foreignKey({
      columns: [t.accountId, t.workspaceId],
      foreignColumns: [accounts.id, accounts.workspaceId],
      name: 'campaigns_account_workspace_fk',
    }).onDelete('restrict'),
    index('campaigns_workspace_idx').on(t.workspaceId),
    // Una campaña 'running' sin cuenta o sin playbook es inejecutable: que no
    // llegue a ese estado en vez de fallar a mitad de la ejecución del agente.
    check(
      'campaigns_running_is_executable',
      sql`${t.status} <> 'running' OR (${t.accountId} IS NOT NULL AND ${t.playbookId} IS NOT NULL)`,
    ),
    check(
      'campaigns_daily_cap_range',
      sql`${t.dailyCap} > 0 AND ${t.dailyCap} <= ${sql.raw(String(MAX_DAILY_LIMIT))}`,
    ),
    check('campaigns_max_touches_range', sql`${t.maxTouches} > 0 AND ${t.maxTouches} <= 10`),
  ],
)

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    headline: text('headline'),
    company: text('company'),
    linkedinUrl: text('linkedin_url'),
    email: text('email'),
    /** Sin arroba. Es el identificador de un prospecto de Instagram. */
    instagramUsername: text('instagram_username'),
    /** Id del perfil en Unipile, se rellena al resolver el lead. */
    providerId: text('provider_id'),
    status: leadStatusEnum('status').notNull().default('nuevo'),
    score: integer('score'),
    qualification: jsonb('qualification').$type<Qualification>(),
    /** Solo cuenta toques con status 'enviado'. Un borrador no gasta toque. */
    touchCount: integer('touch_count').notNull().default(0),
    nextActionAt: timestamp('next_action_at', { withTimezone: true }),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /**
     * Lo que se averiguó del prospecto antes de escribirle: su perfil y la web
     * de su empresa. Es la diferencia entre un mensaje genérico y uno que
     * demuestra que te has mirado a quién escribes.
     */
    enrichment: jsonb('enrichment').$type<Enrichment>(),
    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('leads_campaign_status_idx').on(t.campaignId, t.status),
    // Parcial: la cola de trabajo solo mira leads que el agente aún puede tocar.
    index('leads_next_action_at_idx')
      .on(t.nextActionAt)
      .where(sql`${t.status} NOT IN (${TERMINAL_STATUSES_SQL})`),
    // Resolver un webhook entrante por el id de perfil de Unipile.
    index('leads_provider_id_idx').on(t.providerId).where(sql`${t.providerId} IS NOT NULL`),
    /**
     * Deduplicación por identidad, no por texto literal: "Ana@X.com" y
     * "ana@x.com" son la misma persona, y "linkedin.com/in/ana",
     * "https://www.linkedin.com/in/ana" y ".../ana/" también. Sin esto, un CSV
     * con la URL escrita de otra forma le escribe dos veces al mismo prospecto.
     */
    uniqueIndex('leads_campaign_linkedin_url_key')
      .on(t.campaignId, normalizedLinkedinUrl(t.linkedinUrl))
      .where(sql`${t.linkedinUrl} IS NOT NULL`),
    uniqueIndex('leads_campaign_email_key')
      .on(t.campaignId, normalizedEmail(t.email))
      .where(sql`${t.email} IS NOT NULL`),
    uniqueIndex('leads_campaign_instagram_key')
      .on(t.campaignId, normalizedHandle(t.instagramUsername))
      .where(sql`${t.instagramUsername} IS NOT NULL`),
    // El mismo perfil de Unipile no puede estar dos veces en la misma campaña:
    // si no, un mensaje entrante se cuelga de la fila equivocada.
    uniqueIndex('leads_campaign_provider_id_key')
      .on(t.campaignId, t.providerId)
      .where(sql`${t.providerId} IS NOT NULL`),
    check('leads_score_range', sql`${t.score} IS NULL OR (${t.score} >= 0 AND ${t.score} <= 100)`),
    check('leads_touch_count_positive', sql`${t.touchCount} >= 0`),
    // Un lead sin ningún identificador es incontactable, no tiene sentido guardarlo.
    check(
      'leads_contactable',
      sql`${t.linkedinUrl} IS NOT NULL OR ${t.email} IS NOT NULL
          OR ${t.instagramUsername} IS NOT NULL OR ${t.providerId} IS NOT NULL`,
    ),
  ],
)

export const touches = pgTable(
  'touches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    /**
     * Cuenta por la que salió (o entró) el mensaje, congelada en el momento del
     * envío. No se deriva de campaigns.account_id porque esa columna es mutable:
     * reasignar una campaña a otra cuenta reescribiría el histórico de cuota y
     * dejaría a la cuenta original infracontada, libre para pasarse del tope.
     */
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    step: integer('step').notNull().default(1),
    channel: channelEnum('channel').notNull(),
    direction: touchDirectionEnum('direction').notNull(),
    /**
     * Por defecto `borrador`: nada se da por enviado sin decirlo explícitamente.
     * Es lo que permite que, con el autopiloto apagado, W1 redacte y pare.
     */
    status: touchStatusEnum('status').notNull().default('borrador'),
    body: text('body').notNull(),
    unipileMessageId: text('unipile_message_id'),
    unipileChatId: text('unipile_chat_id'),
    /**
     * Cuándo salió de verdad, no cuándo se redactó. El tope diario se cuenta
     * sobre esta columna: un borrador de hace tres días que se aprueba hoy
     * consume la cuota de HOY.
     */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('touches_lead_id_created_at_idx').on(t.leadId, t.createdAt),
    // Idempotencia del webhook de Unipile: el mismo mensaje no entra dos veces.
    uniqueIndex('touches_unipile_message_id_key')
      .on(t.unipileMessageId)
      .where(sql`${t.unipileMessageId} IS NOT NULL`),
    index('touches_unipile_chat_id_idx')
      .on(t.unipileChatId)
      .where(sql`${t.unipileChatId} IS NOT NULL`),
    // Cuota diaria por cuenta: cuántos mensajes salieron de verdad hoy.
    index('touches_account_sent_at_idx')
      .on(t.accountId, t.sentAt)
      .where(sql`${t.direction} = 'out' AND ${t.sentAt} IS NOT NULL`),
    // Cola de aprobación del dashboard con el autopiloto apagado.
    index('touches_borradores_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'borrador'`),
    // "Enviado" y "tiene fecha de envío" son la misma cosa; que no puedan divergir.
    check(
      'touches_sent_at_matches_status',
      sql`(${t.status} = 'enviado') = (${t.sentAt} IS NOT NULL)`,
    ),
    // Un mensaje entrante no puede ser un borrador: ya ha ocurrido.
    check(
      'touches_inbound_is_sent',
      sql`${t.direction} = 'out' OR ${t.status} = 'enviado'`,
    ),
  ],
)

export const meetings = pgTable(
  'meetings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    composioEventId: text('composio_event_id'),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    meetUrl: text('meet_url'),
    status: meetingStatusEnum('status').notNull().default('booked'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('meetings_start_at_idx').on(t.startAt),
    index('meetings_lead_id_idx').on(t.leadId),
    // Si el workflow reintenta, no se duplica la reunión.
    uniqueIndex('meetings_composio_event_id_key')
      .on(t.composioEventId)
      .where(sql`${t.composioEventId} IS NOT NULL`),
    check('meetings_end_after_start', sql`${t.endAt} > ${t.startAt}`),
  ],
)

export const runLogs = pgTable(
  'run_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflow: text('workflow').notNull(),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    level: logLevelEnum('level').notNull().default('info'),
    message: text('message').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('run_logs_workflow_created_at_idx').on(t.workflow, t.createdAt),
    index('run_logs_lead_id_created_at_idx').on(t.leadId, t.createdAt),
    index('run_logs_level_created_at_idx').on(t.level, t.createdAt),
  ],
)

/* -------------------------------------------------------------------------- */
/* Prospección asistida por IA (Apify)                                         */
/* -------------------------------------------------------------------------- */

export const searchStatusEnum = pgEnum('search_status', [
  'pendiente',
  'ejecutando',
  'puntuando',
  'completada',
  'fallida',
])

export const prospectDecisionEnum = pgEnum('prospect_decision', [
  'pendiente',
  'importado',
  'descartado',
])

export const icpVerdictEnum = pgEnum('icp_verdict', ['encaja', 'dudoso', 'no_encaja'])

/** Quién lanzó la búsqueda. Las automáticas se auditan distinto: gastan solas. */
export const searchOriginEnum = pgEnum('search_origin', ['manual', 'automatica'])

/** Lo que el LLM traduce del ICP al formulario del actor de Apify. */
export type ApifyActorInput = Record<string, unknown>

export type SearchStats = {
  encontrados: number
  /** Perfiles que ya estaban en el sistema y se descartaron antes de puntuar. */
  yaConocidos?: number
  /** Candidatos que entraron solos en la campaña (solo reabastecimiento). */
  autoImportados?: number
  puntuados: number
  encajan: number
  descartados: number
  /** Coste de la ejecución de Apify, si el run lo reporta. */
  coste_apify_usd?: number
  /** Coste del LLM que tradujo el ICP y puntuó los candidatos. */
  coste_llm_usd?: number
}

/**
 * Una búsqueda de prospectos: el ICP se traduce a filtros de un actor de Apify,
 * se ejecuta, y cada candidato se puntúa contra el propio ICP antes de que un
 * humano decida a quién importar.
 *
 * Deliberadamente NO escribe en `leads` de forma automática. Un scraper que
 * alimenta directo a una cola de envío es la forma más rápida de escribirle a
 * quien no tocaba.
 */
export const prospectSearches = pgTable(
  'prospect_searches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'restrict' }),
    icpId: uuid('icp_id')
      .notNull()
      .references(() => icps.id, { onDelete: 'restrict' }),
    /** Campaña de destino sugerida al importar. Puede decidirse después. */
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    source: channelEnum('source').notNull(),
    /** Instrucción en lenguaje natural del usuario, si añadió alguna. */
    brief: text('brief'),
    origin: searchOriginEnum('origin').notNull().default('manual'),
    /**
     * Etiqueta corta del ángulo de búsqueda ("fundadores de agencia en Madrid").
     * El reabastecimiento se la pasa al modelo como lista de lo ya intentado
     * para que la siguiente búsqueda traiga gente DISTINTA y no la misma.
     */
    angle: text('angle'),
    /**
     * Si los candidatos que superan el umbral entran solos en la campaña.
     * Las búsquedas manuales van a false: las revisa una persona. Solo el
     * reabastecimiento automático lo pone a true, y solo si está activado.
     */
    autoImport: boolean('auto_import').notNull().default(false),
    /** Actor de Apify, p.ej. "harvestapi/linkedin-profile-search". */
    actor: text('actor').notNull(),
    /** Cuerpo exacto que se le pasó al actor. Queda para poder reproducirlo. */
    input: jsonb('input').$type<ApifyActorInput>().notNull(),
    /** Por qué el LLM eligió esos filtros. Es lo que se audita cuando falla. */
    inputReasoning: text('input_reasoning'),
    apifyRunId: text('apify_run_id'),
    apifyDatasetId: text('apify_dataset_id'),
    status: searchStatusEnum('status').notNull().default('pendiente'),
    stats: jsonb('stats').$type<SearchStats>(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('prospect_searches_status_idx').on(t.status, t.createdAt),
    // Cuántas búsquedas automáticas van hoy: es el freno de gasto.
    index('prospect_searches_origin_created_at_idx').on(t.origin, t.createdAt),
    // Sondear el estado de un run de Apify sin recorrer la tabla.
    uniqueIndex('prospect_searches_apify_run_id_key')
      .on(t.apifyRunId)
      .where(sql`${t.apifyRunId} IS NOT NULL`),
  ],
)

/**
 * Candidato encontrado por una búsqueda, ya puntuado contra el ICP pero todavía
 * fuera del embudo. Es la sala de espera entre el scraping y `leads`.
 */
export const prospects = pgTable(
  'prospects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    searchId: uuid('search_id')
      .notNull()
      .references(() => prospectSearches.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    headline: text('headline'),
    company: text('company'),
    location: text('location'),
    linkedinUrl: text('linkedin_url'),
    instagramUsername: text('instagram_username'),
    email: text('email'),
    providerId: text('provider_id'),
    icpScore: integer('icp_score'),
    icpVerdict: icpVerdictEnum('icp_verdict'),
    /** Por qué encaja o no. Es lo que se lee antes de decidir importarlo. */
    icpReasoning: text('icp_reasoning'),
    decision: prospectDecisionEnum('decision').notNull().default('pendiente'),
    /** Se rellena al importar. Si está, el prospecto ya vive en el embudo. */
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // La pantalla de revisión: los mejores candidatos pendientes primero.
    index('prospects_search_decision_score_idx').on(t.searchId, t.decision, t.icpScore),
    index('prospects_lead_id_idx').on(t.leadId).where(sql`${t.leadId} IS NOT NULL`),
    // Un actor de Apify devuelve duplicados con frecuencia.
    uniqueIndex('prospects_search_linkedin_key')
      .on(t.searchId, normalizedLinkedinUrl(t.linkedinUrl))
      .where(sql`${t.linkedinUrl} IS NOT NULL`),
    uniqueIndex('prospects_search_instagram_key')
      .on(t.searchId, normalizedHandle(t.instagramUsername))
      .where(sql`${t.instagramUsername} IS NOT NULL`),
    check(
      'prospects_icp_score_range',
      sql`${t.icpScore} IS NULL OR (${t.icpScore} >= 0 AND ${t.icpScore} <= 100)`,
    ),
    check(
      'prospects_contactable',
      sql`${t.linkedinUrl} IS NOT NULL OR ${t.instagramUsername} IS NOT NULL
          OR ${t.email} IS NOT NULL OR ${t.providerId} IS NOT NULL`,
    ),
    // Importado implica lead: si no, se pierde el rastro de a dónde fue.
    check(
      'prospects_imported_has_lead',
      sql`${t.decision} <> 'importado' OR ${t.leadId} IS NOT NULL`,
    ),
  ],
)

/* -------------------------------------------------------------------------- */
/* Lead magnets de Instagram                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Estado de una persona que ha comentado la palabra clave.
 *
 * El orden es el del embudo y no se salta pasos: no se entrega el recurso a
 * quien no se ha verificado, y no se verifica a quien no ha comentado.
 */
export const magnetStateEnum = pgEnum('magnet_state', [
  'detectado',
  'pidiendo_follow',
  'verificado',
  'entregado',
  'en_conversacion',
  'descartado',
])

export const leadMagnets = pgTable(
  'lead_magnets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Cuenta de Instagram por la que se responde. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** Publicación cuyos comentarios se vigilan. */
    postUrl: text('post_url').notNull(),
    /** La palabra que tienen que comentar. Se compara sin acentos ni mayúsculas. */
    keyword: text('keyword').notNull(),
    /** Lo que se les manda cuando se confirma que siguen la cuenta. */
    resource: text('resource').notNull(),
    /** Lo que se les dice mientras todavía no siguen. */
    followMessage: text('follow_message').notNull(),
    /** Si al entregar el recurso se intenta además llevarlos a una reunión. */
    pitchMeeting: boolean('pitch_meeting').notNull().default(true),
    active: boolean('active').notNull().default(false),
    /** Cuántas veces se ha mirado la publicación y cuándo fue la última. */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('lead_magnets_activos_idx').on(t.active, t.lastCheckedAt).where(sql`${t.active}`),
    index('lead_magnets_workspace_idx').on(t.workspaceId),
    // La cuenta tiene que ser del mismo workspace que el imán.
    foreignKey({
      columns: [t.accountId, t.workspaceId],
      foreignColumns: [accounts.id, accounts.workspaceId],
      name: 'lead_magnets_account_workspace_fk',
    }).onDelete('restrict'),
  ],
)

export const magnetContacts = pgTable(
  'magnet_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    magnetId: uuid('magnet_id')
      .notNull()
      .references(() => leadMagnets.id, { onDelete: 'cascade' }),
    /** Sin arroba, en minúsculas. */
    username: text('username').notNull(),
    fullName: text('full_name'),
    /** Id del comentario, para no procesar dos veces el mismo. */
    commentId: text('comment_id'),
    providerId: text('provider_id'),
    unipileChatId: text('unipile_chat_id'),
    state: magnetStateEnum('state').notNull().default('detectado'),
    /** Cuántas veces se le ha pedido que siga. Hay un tope. */
    followAsks: integer('follow_asks').notNull().default(0),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /** Si acabó convertido en lead del embudo normal. */
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * Una persona, una vez por imán. Es lo que impide mandarle el recurso dos
     * veces a quien comenta la palabra tres veces, que en Instagram pasa mucho.
     */
    uniqueIndex('magnet_contacts_magnet_username_key').on(t.magnetId, t.username),
    index('magnet_contacts_cola_idx').on(t.state, t.createdAt),
    uniqueIndex('magnet_contacts_comment_key')
      .on(t.commentId)
      .where(sql`${t.commentId} IS NOT NULL`),
  ],
)

/**
 * Quién sigue a cada cuenta. Se refresca por lotes.
 *
 * Se guarda la lista entera y se consulta por índice, en vez de mirar a quién
 * sigue cada persona una por una: la comprobación individual cuesta una
 * ejecución de scraping por contacto y sale carísima en cuanto el imán funciona.
 */
export const followers = pgTable(
  'followers',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.username] }),
    index('followers_seen_idx').on(t.accountId, t.seenAt),
  ],
)

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
})
