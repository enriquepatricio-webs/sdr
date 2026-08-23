/**
 * Verificación del esquema contra un Postgres de verdad (PGlite, en memoria).
 *
 * No hace falta Neon ni Docker: `npm run db:verify`.
 *
 * Comprueba dos cosas que el typecheck no puede ver:
 *   1. Que la migración generada se ejecuta sin error en Postgres.
 *   2. Que las restricciones que protegen al prospecto (idempotencia, topes
 *      de envío, un solo playbook activo) rechazan de verdad lo que deben.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { type SeedDb, runSeed } from './seed'
import {
  MAX_DAILY_LIMIT,
  MAX_HOURLY_LIMIT,
  TERMINAL_LEAD_STATUSES,
  accounts,
  campaigns,
  leads,
  playbooks,
  settings,
} from './schema'

/**
 * TODAS las migraciones, en orden. No solo la primera: aplicar únicamente
 * 0000 hacía que el esquema de las pruebas se quedase atrás respecto al de
 * Drizzle, y el seed fallaba con un error de columna inexistente que parecía
 * un fallo del seed y era del propio test.
 */
const DIR = join(process.cwd(), 'drizzle')
const MIGRACIONES = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => join(DIR, f))

const db = new PGlite()

let passed = 0
const failures: string[] = []

async function ok(label: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    passed++
  } catch (err) {
    failures.push(`${label}\n    esperaba que funcionase, falló: ${(err as Error).message}`)
  }
}

/**
 * El caso importante: la base de datos DEBE rechazar esto.
 *
 * `on` es obligatorio para no repetir el fallo de apuntar sin querer a otra
 * instancia: una sentencia que falla por la razón equivocada (una FK de datos
 * que no existen ahí) daría un falso verde.
 */
async function rejects(on: PGlite, label: string, sql: string) {
  try {
    await on.exec(sql)
    failures.push(`${label}\n    Postgres lo ACEPTÓ y debería haberlo rechazado`)
  } catch {
    passed++
  }
}

async function main() {
  /* ---- 1. La migración se aplica ---------------------------------------- */

  const statements = MIGRACIONES.flatMap((ruta) =>
    readFileSync(ruta, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean),
  )

  for (const [i, stmt] of statements.entries()) {
    try {
      await db.exec(stmt)
    } catch (err) {
      throw new Error(
        `La migración falla en la sentencia ${i + 1}/${statements.length}:\n${stmt}\n\n${(err as Error).message}`,
      )
    }
  }
  passed++
  console.log(
    `✓ ${MIGRACIONES.length} migración(es) aplicadas (${statements.length} sentencias)`,
  )

  /* ---- 2. Está todo lo que el spec pide --------------------------------- */

  const tables = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema='public' order by 1`,
  )
  const names = tables.rows.map((r) => r.table_name)
  await ok('12 tablas: las 9 del spec, las dos de prospección y la de empresas', async () =>
    assert.deepEqual(names, [
      'accounts',
      'campaigns',
      'icps',
      'leads',
      'meetings',
      'playbooks',
      'prospect_searches',
      'prospects',
      'run_logs',
      'sellers',
      'settings',
      'touches',
    ]),
  )

  const status = await db.query<{ enumlabel: string }>(
    `select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid
     where t.typname='lead_status' order by e.enumsortorder`,
  )
  await ok('enum lead_status completo y en orden de flujo', async () =>
    assert.deepEqual(
      status.rows.map((r) => r.enumlabel),
      [
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
      ],
    ),
  )

  const idx = await db.query<{ indexname: string; indexdef: string }>(
    `select indexname, indexdef from pg_indexes where schemaname='public'`,
  )
  const byName = new Map(idx.rows.map((r) => [r.indexname, r.indexdef]))

  for (const required of [
    'leads_campaign_status_idx',
    'leads_next_action_at_idx',
    'touches_lead_id_created_at_idx',
  ]) {
    await ok(`índice obligatorio ${required}`, async () =>
      assert.ok(byName.has(required), `falta el índice ${required}`),
    )
  }

  await ok('leads_next_action_at_idx es parcial y excluye los 5 estados terminales', async () => {
    const def = byName.get('leads_next_action_at_idx') ?? ''
    assert.match(def, /WHERE/i)
    for (const terminal of [
      'descartado',
      'agendado',
      'no_interesado',
      'error',
      'revision_humana',
    ]) {
      assert.ok(def.includes(terminal), `el predicado no excluye '${terminal}': ${def}`)
    }
  })

  /* ---- 3. Datos base para las pruebas de restricciones ------------------- */

  await db.exec(`
    insert into accounts (id, unipile_account_id, provider, display_name)
      values ('11111111-1111-1111-1111-111111111111','acc-1','linkedin','LinkedIn');
    insert into playbooks (id, name, version, system_prompt, offer, booking_rules, is_active)
      values ('22222222-2222-2222-2222-222222222222','pb',1,'sp','of','{}'::jsonb, true);
    insert into campaigns (id, name, channel, sending_window, account_id, playbook_id)
      values ('33333333-3333-3333-3333-333333333333','camp','linkedin','{}'::jsonb,
              '11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222');
    insert into leads (id, campaign_id, full_name, linkedin_url)
      values ('44444444-4444-4444-4444-444444444444','33333333-3333-3333-3333-333333333333','Ana','https://li/ana');
  `)
  passed++

  /* ---- 4. Topes de envío (restricción no negociable nº 10) --------------- */

  await ok('daily_limit 80 es válido (el techo)', () =>
    db.exec(`update accounts set daily_limit = 80`),
  )
  await rejects(
    db,
    'daily_limit 81 se rechaza: nunca por encima de 80',
    `update accounts set daily_limit = 81`,
  )
  await rejects(db, 'daily_limit 0 se rechaza', `update accounts set daily_limit = 0`)
  await rejects(
    db,
    'daily_cap de campaña 81 se rechaza',
    `update campaigns set daily_cap = 81`,
  )

  /* ---- 5. Idempotencia del webhook de Unipile (restricción nº 10) -------- */

  const LEAD = "'44444444-4444-4444-4444-444444444444'"

  await ok('primer mensaje entrante entra', () =>
    db.exec(`insert into touches (lead_id, channel, direction, status, sent_at, body, unipile_message_id)
             values (${LEAD},'linkedin','in','enviado', now(),'hola','msg-1')`),
  )
  await rejects(
    db,
    'el MISMO unipile_message_id no entra dos veces (webhook duplicado)',
    `insert into touches (lead_id, channel, direction, status, sent_at, body, unipile_message_id)
     values (${LEAD},'linkedin','in','enviado', now(),'hola','msg-1')`,
  )
  await ok('varios borradores sin unipile_message_id conviven', () =>
    db.exec(`insert into touches (lead_id, channel, direction, body) values
             (${LEAD},'linkedin','out','borrador 1'),
             (${LEAD},'linkedin','out','borrador 2')`),
  )

  /* ---- 5b. Ciclo de vida del toque -------------------------------------- */
  /* Con el autopiloto apagado W1 redacta y para: el borrador tiene que poder
     existir sin ser confundido nunca con un mensaje ya enviado. */

  await ok('un toque nace como borrador, sin fecha de envío', async () => {
    const r = await db.query<{ status: string; sent_at: string | null }>(
      `select status, sent_at from touches where body = 'borrador 1'`,
    )
    assert.equal(r.rows[0].status, 'borrador')
    assert.equal(r.rows[0].sent_at, null)
  })
  await rejects(
    db,
    'un borrador con fecha de envío se rechaza (contradicción)',
    `insert into touches (lead_id, channel, direction, status, sent_at, body)
     values (${LEAD},'linkedin','out','borrador', now(), 'incoherente')`,
  )
  await rejects(
    db,
    'un "enviado" sin fecha de envío se rechaza: rompería el tope diario',
    `insert into touches (lead_id, channel, direction, status, body)
     values (${LEAD},'linkedin','out','enviado','sin fecha')`,
  )
  await rejects(
    db,
    'un mensaje entrante no puede ser un borrador: ya ha ocurrido',
    `insert into touches (lead_id, channel, direction, status, body)
     values (${LEAD},'linkedin','in','borrador','entrante raro')`,
  )
  await ok('aprobar un borrador lo pasa a enviado con su fecha', () =>
    db.exec(`update touches set status='enviado', sent_at=now(), unipile_message_id='msg-2'
             where body='borrador 1'`),
  )
  await ok('un envío fallido se registra y no queda como enviado', () =>
    db.exec(`update touches set status='fallido' where body='borrador 2'`),
  )
  await ok('el tope diario solo cuenta los realmente enviados', async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from touches
       where direction='out' and sent_at >= date_trunc('day', now())`,
    )
    // De los 3 salientes (2 borradores + el aprobado), solo 1 salió de verdad.
    assert.equal(r.rows[0].n, 1)
  })

  /* ---- 6. No duplicar leads al reimportar el mismo CSV ------------------- */

  await rejects(
    db,
    'reimportar el mismo linkedin_url en la campaña se rechaza',
    `insert into leads (campaign_id, full_name, linkedin_url)
     values ('33333333-3333-3333-3333-333333333333','Ana Duplicada','https://li/ana')`,
  )
  await ok('el mismo linkedin_url en OTRA campaña sí entra', () =>
    db.exec(`
      insert into campaigns (id,name,channel,sending_window)
        values ('55555555-5555-5555-5555-555555555555','otra','email','{}'::jsonb);
      insert into leads (campaign_id, full_name, linkedin_url)
        values ('55555555-5555-5555-5555-555555555555','Ana','https://li/ana');
    `),
  )
  await rejects(
    db,
    'un lead sin linkedin_url, sin email y sin provider_id se rechaza (incontactable)',
    `insert into leads (campaign_id, full_name)
     values ('33333333-3333-3333-3333-333333333333','Fantasma')`,
  )

  /* ---- 7. Score y un solo playbook activo -------------------------------- */

  await rejects(
    db,
    'score 101 se rechaza',
    `update leads set score = 101 where id='44444444-4444-4444-4444-444444444444'`,
  )
  await rejects(
    db,
    'score -1 se rechaza',
    `update leads set score = -1 where id='44444444-4444-4444-4444-444444444444'`,
  )
  await ok('score null es válido (lead aún sin cualificar)', () =>
    db.exec(`update leads set score = null where id='44444444-4444-4444-4444-444444444444'`),
  )

  await ok('un playbook inactivo más convive con el activo', () =>
    db.exec(`insert into playbooks (name,version,system_prompt,offer,booking_rules,is_active)
             values ('pb',2,'sp','of','{}'::jsonb,false)`),
  )
  await rejects(
    db,
    'un SEGUNDO playbook activo se rechaza: el agente carga uno y solo uno',
    `update playbooks set is_active = true where version = 2`,
  )
  await rejects(
    db,
    'repetir (name, version) se rechaza',
    `insert into playbooks (name,version,system_prompt,offer,booking_rules)
     values ('pb',2,'sp','of','{}'::jsonb)`,
  )

  /* ---- 8. Reuniones ------------------------------------------------------ */

  await rejects(
    db,
    'una reunión que termina antes de empezar se rechaza',
    `insert into meetings (lead_id,start_at,end_at)
     values ('44444444-4444-4444-4444-444444444444', now(), now() - interval '1 hour')`,
  )
  await ok('reunión válida entra', () =>
    db.exec(`insert into meetings (lead_id,start_at,end_at,composio_event_id)
             values ('44444444-4444-4444-4444-444444444444', now(), now() + interval '30 minutes','evt-1')`),
  )
  await rejects(
    db,
    'reintentar el agendado con el mismo composio_event_id no duplica la reunión',
    `insert into meetings (lead_id,start_at,end_at,composio_event_id)
     values ('44444444-4444-4444-4444-444444444444', now(), now() + interval '30 minutes','evt-1')`,
  )

  /* ---- 9. El índice parcial sirve para la consulta que lo motiva --------- */
  /* Un índice parcial cuyo predicado no case con el WHERE de la consulta es un
     índice muerto: Postgres no puede demostrar la implicación y lo ignora.
     Con la tabla vacía el planificador elige cualquier cosa, así que hacen falta
     filas y estadísticas reales para que la comprobación signifique algo. */

  await db.exec(`
    insert into leads (campaign_id, full_name, linkedin_url, status, next_action_at)
    select '33333333-3333-3333-3333-333333333333', 'Carga '||g, 'https://li/carga/'||g,
      (array['nuevo','contactado','en_seguimiento','respondido','agendado','descartado','no_interesado'])[1+(g%7)]::lead_status,
      now() + ((g%400)||' hours')::interval
    from generate_series(1,20000) g
  `)
  await db.exec(`analyze leads`)

  /* Las dos consultas que de verdad van a correr en producción. */
  const queueQueries: [string, string][] = [
    [
      'la cola de seguimiento de W3 (status IN ...) usa el índice parcial',
      `select id from leads
       where status in ('contactado','en_seguimiento') and next_action_at <= now()
       order by next_action_at limit 25`,
    ],
    [
      'la cola de /api/leads/next (status NOT IN terminales) usa el índice parcial',
      `select id from leads
       where status not in ('descartado','agendado','no_interesado','error','revision_humana')
         and next_action_at <= now()
       order by next_action_at limit 25`,
    ],
  ]

  for (const [label, query] of queueQueries) {
    const plan = await db.query<{ 'QUERY PLAN': string }>(`explain ${query}`)
    const planText = plan.rows.map((r) => r['QUERY PLAN']).join('\n')
    await ok(label, async () =>
      assert.match(
        planText,
        /leads_next_action_at_idx/,
        `plan sin el índice parcial:\n${planText}`,
      ),
    )
  }

  /* ---- 10. El seed entra sin pelearse con ninguna restricción ------------ */
  /* Se siembra sobre una base limpia: si un CHECK o un índice único rechazase
     los datos de ejemplo, el repo estaría roto desde el primer `npm run db:seed`. */

  const seedPg = new PGlite()
  for (const stmt of statements) await seedPg.exec(stmt)
  const seedDb = drizzle(seedPg) as unknown as SeedDb

  let result: Awaited<ReturnType<typeof runSeed>> = null
  await ok('el seed se ejecuta contra Postgres sin errores', async () => {
    result = await runSeed(seedDb)
    assert.ok(result, 'runSeed devolvió null sobre una base vacía')
  })

  await ok('deja exactamente 3 leads dummy en estado "nuevo"', async () => {
    const rows = await seedDb.select({ status: leads.status }).from(leads)
    assert.equal(rows.length, 3)
    assert.ok(rows.every((r) => r.status === 'nuevo'))
  })

  await ok('deja exactamente 1 playbook y está activo', async () => {
    const rows = await seedDb
      .select({ isActive: playbooks.isActive, criteria: playbooks.qualificationCriteria })
      .from(playbooks)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].isActive, true)
  })

  await ok('el autopiloto arranca APAGADO (restricción no negociable)', async () => {
    const rows = await seedDb.select().from(settings).where(eq(settings.key, 'autopilot'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].value, false)
  })

  await ok(`ningún tope diario sembrado supera ${MAX_DAILY_LIMIT}`, async () => {
    const [acc] = await seedDb.select({ limit: accounts.dailyLimit }).from(accounts)
    const [camp] = await seedDb.select({ cap: campaigns.dailyCap }).from(campaigns)
    assert.ok(acc.limit <= MAX_DAILY_LIMIT, `cuenta: ${acc.limit}`)
    assert.ok(camp.cap <= MAX_DAILY_LIMIT, `campaña: ${camp.cap}`)
  })

  await ok('los pesos de cualificación suman 100', async () => {
    const [pb] = await seedDb
      .select({ criteria: playbooks.qualificationCriteria })
      .from(playbooks)
    const total = (pb.criteria ?? []).reduce((sum, c) => sum + c.weight, 0)
    assert.equal(total, 100, `suman ${total}, no 100`)
  })

  await ok('el umbral para agendar es alcanzable pero no trivial', async () => {
    const [pb] = await seedDb
      .select({ criteria: playbooks.qualificationCriteria, rules: playbooks.bookingRules })
      .from(playbooks)
    const weights = (pb.criteria ?? []).map((c) => c.weight).sort((a, b) => b - a)
    const threshold = pb.rules.min_score_to_book
    // Ni tan alto que haga falta cumplirlo todo, ni tan bajo que baste un criterio suelto.
    assert.ok(threshold < 100, 'el umbral exige el 100%: nadie agendaría nunca')
    assert.ok(threshold > weights[0], `basta el criterio de más peso (${weights[0]}) para agendar`)
  })

  await ok('el system prompt recoge las 5 reglas duras del spec', async () => {
    const [pb] = await seedDb.select({ prompt: playbooks.systemPrompt }).from(playbooks)
    for (const rule of [
      'consultar_disponibilidad',
      'registrar_cualificacion',
      'escalar_humano',
      'precio',
      '2 preguntas',
    ]) {
      assert.ok(pb.prompt.includes(rule), `el system prompt no menciona "${rule}"`)
    }
  })

  /* ---- 11. Arreglos de la revisión -------------------------------------- */

  const fixPg = new PGlite()
  for (const stmt of statements) await fixPg.exec(stmt)
  const fixDb = drizzle(fixPg) as unknown as SeedDb

  await fixPg.exec(`
    insert into accounts (id, unipile_account_id, provider, display_name)
      values ('aaaaaaaa-0000-0000-0000-000000000001','li-1','linkedin','LinkedIn'),
             ('aaaaaaaa-0000-0000-0000-000000000002','em-1','email','Gmail');
    insert into playbooks (id,name,version,system_prompt,offer,booking_rules)
      values ('bbbbbbbb-0000-0000-0000-000000000001','pb',1,'sp','of','{}'::jsonb);
    insert into campaigns (id,name,channel,sending_window,account_id,playbook_id)
      values ('cccccccc-0000-0000-0000-000000000001','li','linkedin','{}'::jsonb,
              'aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001');
  `)
  const CAMP = "'cccccccc-0000-0000-0000-000000000001'"

  /* Deduplicación por identidad, no por texto literal. */

  await ok('un email entra una vez', () =>
    fixPg.exec(`insert into leads (campaign_id, full_name, email)
                values (${CAMP},'Ana','Ana@Ejemplo.COM')`),
  )
  await rejects(
      fixPg,
    'el mismo email con otra caja NO entra: sería escribirle dos veces',
    `insert into leads (campaign_id, full_name, email)
     values (${CAMP},'Ana otra vez','ana@ejemplo.com')`,
  )
  await ok('una URL de LinkedIn entra una vez', () =>
    fixPg.exec(`insert into leads (campaign_id, full_name, linkedin_url)
                values (${CAMP},'Beto','https://www.linkedin.com/in/beto')`),
  )
  for (const [variante, url] of [
    ['sin esquema ni www', 'linkedin.com/in/beto'],
    ['con barra final', 'https://www.linkedin.com/in/beto/'],
    ['en mayúsculas', 'https://WWW.LinkedIn.com/in/Beto'],
    ['con el esquema en mayúsculas', 'HTTPS://www.linkedin.com/in/beto'],
    ['con varias barras finales', 'https://www.linkedin.com/in/beto///'],
    ['sin www', 'https://linkedin.com/in/beto'],
  ] as const) {
    await rejects(
      fixPg,
      `la misma URL escrita ${variante} NO duplica el lead`,
      `insert into leads (campaign_id, full_name, linkedin_url)
       values (${CAMP},'Beto duplicado','${url}')`,
    )
  }
  await ok('una URL de LinkedIn distinta sí entra', () =>
    fixPg.exec(`insert into leads (campaign_id, full_name, linkedin_url)
                values (${CAMP},'Carla','https://www.linkedin.com/in/carla')`),
  )
  await rejects(
      fixPg,
    'el mismo provider_id no puede estar dos veces en la campaña',
    `insert into leads (campaign_id, full_name, provider_id) values
     (${CAMP},'Uno','prov-x'), (${CAMP},'Dos','prov-x')`,
  )

  /* Coherencia entre canal de campaña y proveedor de cuenta. */

  await rejects(
      fixPg,
    'una campaña de email NO puede colgar de una cuenta de LinkedIn',
    `insert into campaigns (name,channel,sending_window,account_id)
     values ('cruzada','email','{}'::jsonb,'aaaaaaaa-0000-0000-0000-000000000001')`,
  )
  await ok('una campaña de email con cuenta de email sí entra', () =>
    fixPg.exec(`insert into campaigns (name,channel,sending_window,account_id)
                values ('correcta','email','{}'::jsonb,'aaaaaaaa-0000-0000-0000-000000000002')`),
  )
  await ok('una campaña en borrador puede no tener cuenta todavía', () =>
    fixPg.exec(`insert into campaigns (name,channel,sending_window)
                values ('borrador','linkedin','{}'::jsonb)`),
  )
  await rejects(
      fixPg,
    'una campaña NO puede pasar a "running" sin cuenta ni playbook',
    `update campaigns set status='running' where name='borrador'`,
  )
  await ok('una campaña completa sí puede pasar a "running"', () =>
    fixPg.exec(`update campaigns set status='running' where id=${CAMP}`),
  )

  /* La cuota diaria se atribuye a la cuenta que envió, no a la actual. */

  await ok('touches guarda la cuenta emisora y sobrevive a reasignar la campaña', async () => {
    const [lead] = (
      await fixPg.query<{ id: string }>(`select id from leads where full_name='Carla'`)
    ).rows
    await fixPg.exec(`insert into touches (lead_id, account_id, channel, direction, status, sent_at, body)
      values ('${lead.id}','aaaaaaaa-0000-0000-0000-000000000001','linkedin','out','enviado',now(),'hola')`)
    // La campaña se reasigna a otra cuenta después de haber enviado.
    await fixPg.exec(`update campaigns set account_id='aaaaaaaa-0000-0000-0000-000000000002',
                      channel='email', status='draft' where id=${CAMP}`)
    const r = await fixPg.query<{ n: number }>(
      `select count(*)::int as n from touches
       where account_id='aaaaaaaa-0000-0000-0000-000000000001'
         and direction='out' and sent_at >= date_trunc('day', now())`,
    )
    assert.equal(r.rows[0].n, 1, 'el toque se ha ido con la campaña en vez de quedarse en su cuenta')
  })

  /* updated_at deja de mentir. */

  await ok('leads.updated_at avanza al actualizar', async () => {
    const [before] = await fixDb
      .select({ id: leads.id, updatedAt: leads.updatedAt })
      .from(leads)
      .where(eq(leads.fullName, 'Carla'))
    await new Promise((r) => setTimeout(r, 5))
    await fixDb.update(leads).set({ status: 'contactado' }).where(eq(leads.id, before.id))
    const [after] = await fixDb
      .select({ updatedAt: leads.updatedAt })
      .from(leads)
      .where(eq(leads.id, before.id))
    assert.ok(
      after.updatedAt > before.updatedAt,
      `updated_at no se movió: ${before.updatedAt.toISOString()}`,
    )
  })

  /* El predicado del índice se deriva de la constante, no se copia. */

  await ok('el índice parcial cubre exactamente TERMINAL_LEAD_STATUSES', async () => {
    const def =
      (
        await fixPg.query<{ indexdef: string }>(
          `select indexdef from pg_indexes where indexname='leads_next_action_at_idx'`,
        )
      ).rows[0]?.indexdef ?? ''
    for (const st of TERMINAL_LEAD_STATUSES) {
      assert.ok(def.includes(st), `el predicado no excluye '${st}'`)
    }
    const listed = def.match(/'(\w+)'/g)?.length ?? 0
    assert.equal(
      listed,
      TERMINAL_LEAD_STATUSES.length,
      `el predicado lista ${listed} estados y la constante tiene ${TERMINAL_LEAD_STATUSES.length}`,
    )
  })

  /* ---- 12. Instagram y prospección -------------------------------------- */

  const igPg = new PGlite()
  for (const stmt of statements) await igPg.exec(stmt)

  await igPg.exec(`
    insert into accounts (id, unipile_account_id, provider, display_name, daily_limit, hourly_limit)
      values ('dddddddd-0000-0000-0000-000000000001','ig-1','instagram','Instagram',40,8);
    insert into icps (id,name) values ('eeeeeeee-0000-0000-0000-000000000001','ICP');
    insert into playbooks (id,name,version,system_prompt,offer,booking_rules)
      values ('ffffffff-0000-0000-0000-000000000001','pb',1,'sp','of','{}'::jsonb);
  `)

  /* Instagram exige tope horario: 100/día en diez minutos es lo que detecta el antifraude. */

  await rejects(
    igPg,
    `un tope horario por encima de ${MAX_HOURLY_LIMIT} se rechaza`,
    `update accounts set hourly_limit = ${MAX_HOURLY_LIMIT + 1} where unipile_account_id='ig-1'`,
  )
  await rejects(
    igPg,
    'un tope horario mayor que el diario se rechaza: no significa nada',
    `update accounts set hourly_limit = 45 where unipile_account_id='ig-1'`,
  )
  await ok('sin tope horario también vale (LinkedIn y email no lo necesitan)', () =>
    igPg.exec(`insert into accounts (unipile_account_id, provider, display_name)
               values ('li-2','linkedin','LinkedIn')`),
  )

  await ok('una campaña de Instagram con cuenta de Instagram entra', () =>
    igPg.exec(`insert into campaigns (id,name,channel,sending_window,account_id,playbook_id)
               values ('11110000-0000-0000-0000-000000000001','ig','instagram','{}'::jsonb,
                       'dddddddd-0000-0000-0000-000000000001','ffffffff-0000-0000-0000-000000000001')`),
  )
  await rejects(
    igPg,
    'una campaña de Instagram NO puede colgar de una cuenta de LinkedIn',
    `insert into campaigns (name,channel,sending_window,account_id)
     select 'cruzada','instagram','{}'::jsonb, id from accounts where unipile_account_id='li-2'`,
  )

  const IGCAMP = "'11110000-0000-0000-0000-000000000001'"

  await ok('un lead solo con usuario de Instagram es contactable', () =>
    igPg.exec(`insert into leads (campaign_id, full_name, instagram_username)
               values (${IGCAMP},'Nuria','@NuriaDemo')`),
  )
  for (const [variante, handle] of [
    ['sin arroba', 'nuriademo'],
    ['en mayúsculas', 'NURIADEMO'],
    ['con espacios', '  nuriademo '],
  ] as const) {
    await rejects(
      igPg,
      `el mismo usuario de Instagram escrito ${variante} no duplica el lead`,
      `insert into leads (campaign_id, full_name, instagram_username)
       values (${IGCAMP},'Nuria duplicada','${handle}')`,
    )
  }

  /* La sala de espera entre el scraping y el embudo. */

  await ok('una búsqueda de prospectos se registra con su actor y su entrada', () =>
    igPg.exec(`insert into prospect_searches (id, icp_id, name, source, actor, input)
               values ('22220000-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-000000000001',
                       'Fundadores B2B','linkedin','harvestapi/linkedin-profile-search',
                       '{"searchQuery":"fundador consultoria"}'::jsonb)`),
  )
  const SEARCH = "'22220000-0000-0000-0000-000000000001'"

  await ok('un candidato puntuado entra', () =>
    igPg.exec(`insert into prospects (search_id, full_name, linkedin_url, icp_score, icp_verdict)
               values (${SEARCH},'Pablo','https://www.linkedin.com/in/pablo',82,'encaja')`),
  )
  await rejects(
    igPg,
    'el mismo perfil devuelto dos veces por el actor no se duplica',
    `insert into prospects (search_id, full_name, linkedin_url)
     values (${SEARCH},'Pablo otra vez','linkedin.com/in/pablo/')`,
  )
  await rejects(
    igPg,
    'un candidato sin ninguna forma de contactarlo se rechaza',
    `insert into prospects (search_id, full_name) values (${SEARCH},'Fantasma')`,
  )
  await rejects(
    igPg,
    'un score de ICP fuera de 0-100 se rechaza',
    `update prospects set icp_score = 140 where full_name='Pablo'`,
  )
  await rejects(
    igPg,
    'marcar un candidato como importado sin lead se rechaza: se perdería el rastro',
    `update prospects set decision='importado' where full_name='Pablo'`,
  )
  await ok('importar un candidato lo ata a su lead', async () => {
    await igPg.exec(`insert into leads (id, campaign_id, full_name, linkedin_url)
                     values ('33330000-0000-0000-0000-000000000001',${IGCAMP},'Pablo','https://www.linkedin.com/in/pablo')`)
    await igPg.exec(`update prospects set decision='importado',
                     lead_id='33330000-0000-0000-0000-000000000001' where full_name='Pablo'`)
    const r = await igPg.query<{ n: number }>(
      `select count(*)::int as n from prospects where decision='importado' and lead_id is not null`,
    )
    assert.equal(r.rows[0].n, 1)
  })
  await ok('descartar un candidato no exige lead', () =>
    igPg.exec(`insert into prospects (search_id, full_name, instagram_username, decision)
               values (${SEARCH},'Rita','rita_demo','descartado')`),
  )

  /* ---- 13. Activar un playbook -------------------------------------------- */
  /* Regresión: `update playbooks set is_active = (id = $1)` en una sola sentencia
     revienta o no según el orden físico de las filas, porque el índice único
     parcial se comprueba fila a fila. Tienen que ser dos sentencias ordenadas. */

  const pbPg = new PGlite()
  for (const stmt of statements) await pbPg.exec(stmt)
  for (let v = 1; v <= 6; v++) {
    await pbPg.exec(`insert into playbooks (id,name,version,system_prompt,offer,booking_rules,is_active)
      values ('aaaa0000-0000-0000-0000-00000000000${v}','pb',${v},'sp','of','{}'::jsonb, ${v === 1})`)
  }

  await ok('se puede activar cualquier versión, venga antes o después de la activa', async () => {
    for (const v of [6, 2, 1, 4]) {
      const id = `aaaa0000-0000-0000-0000-00000000000${v}`
      await pbPg.exec(`begin;
        update playbooks set is_active = false where is_active and id <> '${id}';
        update playbooks set is_active = true where id = '${id}';
      commit;`)
      const r = await pbPg.query<{ version: number; n: number }>(
        `select version, count(*) over ()::int as n from playbooks where is_active`,
      )
      assert.equal(r.rows.length, 1, `quedaron ${r.rows.length} playbooks activos al activar la v${v}`)
      assert.equal(r.rows[0].version, v)
    }
  })

  await ok('la versión de una sola sentencia SÍ falla (por eso no se usa)', async () => {
    let fallo = false
    try {
      await pbPg.exec(
        `update playbooks set is_active = (id = 'aaaa0000-0000-0000-0000-000000000001')`,
      )
    } catch {
      fallo = true
    }
    assert.ok(
      fallo,
      'el UPDATE de una sola sentencia ya no falla: revisa si sigue haciendo falta lib/playbook.ts',
    )
  })

  /* ---- Resultado --------------------------------------------------------- */

  console.log(`\n${passed} comprobaciones correctas`)
  if (failures.length) {
    console.error(`\n${failures.length} FALLOS:\n`)
    for (const f of failures) console.error(`  ✗ ${f}\n`)
    process.exit(1)
  }
  console.log('Esquema verificado contra Postgres.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message ?? err)
    process.exit(1)
  })
