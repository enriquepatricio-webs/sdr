import Link from 'next/link'
import { and, count, eq, gte, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { campaigns, leads, meetings, runLogs, touches } from '@/lib/db/schema'
import { getSettings } from '@/lib/settings'
import { ParadaDeEmergencia } from './parada'

export const dynamic = 'force-dynamic'

const EMBUDO = [
  { estado: 'nuevo', etiqueta: 'Nuevos' },
  { estado: 'contactado', etiqueta: 'Contactados' },
  { estado: 'en_seguimiento', etiqueta: 'En seguimiento' },
  { estado: 'respondido', etiqueta: 'Respondieron' },
  { estado: 'cualificando', etiqueta: 'Cualificando' },
  { estado: 'cualificado', etiqueta: 'Cualificados' },
  { estado: 'agendado', etiqueta: 'Agendados' },
] as const

const SALIDAS = [
  { estado: 'no_interesado', etiqueta: 'No interesados' },
  { estado: 'descartado', etiqueta: 'Descartados' },
  { estado: 'revision_humana', etiqueta: 'En revisión' },
  { estado: 'error', etiqueta: 'Con error' },
] as const

function Kpi({ etiqueta, valor, nota }: { etiqueta: string; valor: string; nota?: string }) {
  return (
    <div className="border border-linea bg-lienzo p-4">
      <p className="etiqueta">{etiqueta}</p>
      <p className="mt-1 font-mono text-3xl leading-none">{valor}</p>
      {nota && <p className="mt-1 text-xs text-tenue">{nota}</p>}
    </div>
  )
}

export default async function Panel() {
  const hace30dias = new Date(Date.now() - 30 * 24 * 3600_000)

  const [porEstado, contactados, respuestas, reuniones, activas, ajustes, coste] = await Promise.all([
    db.select({ status: leads.status, n: count() }).from(leads).groupBy(leads.status),
    db
      .select({ n: count() })
      .from(touches)
      .where(and(eq(touches.direction, 'out'), eq(touches.status, 'enviado'), gte(touches.sentAt, hace30dias))),
    db
      .select({ n: sql<number>`count(distinct ${touches.leadId})::int` })
      .from(touches)
      .where(and(eq(touches.direction, 'in'), gte(touches.createdAt, hace30dias))),
    db.select({ n: count() }).from(meetings).where(gte(meetings.createdAt, hace30dias)),
    db.select({ n: count() }).from(campaigns).where(eq(campaigns.status, 'running')),
    getSettings().catch(() => null),
    // Coste real de OpenRouter: se acumula desde los registros que lo llevan.
    db
      .select({ total: sql<number>`coalesce(sum((${runLogs.payload}->>'coste_usd')::numeric), 0)::float` })
      .from(runLogs)
      .where(gte(runLogs.createdAt, hace30dias)),
  ])

  const conteo = new Map(porEstado.map((r) => [r.status, Number(r.n)]))
  const total = porEstado.reduce((s, r) => s + Number(r.n), 0)
  const maximo = Math.max(1, ...EMBUDO.map((e) => conteo.get(e.estado) ?? 0))

  const nContactados = Number(contactados[0]?.n ?? 0)
  const nRespuestas = Number(respuestas[0]?.n ?? 0)
  const nCualificados = (conteo.get('cualificado') ?? 0) + (conteo.get('agendado') ?? 0)
  const nReuniones = Number(reuniones[0]?.n ?? 0)
  const costeUsd = Number(coste[0]?.total ?? 0)

  const pct = (parte: number, sobre: number) => (sobre ? `${Math.round((parte / sobre) * 100)} %` : '—')

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="etiqueta">Últimos 30 días</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            {total} {total === 1 ? 'lead' : 'leads'} en el sistema
          </h1>
          <p className="mt-1 text-sm text-apagado">
            {Number(activas[0]?.n ?? 0)} campañas en marcha · autopiloto{' '}
            {ajustes?.autopilot ? (
              <span className="font-semibold text-vivo">encendido</span>
            ) : (
              'apagado'
            )}
          </p>
        </div>
        <ParadaDeEmergencia campanasActivas={Number(activas[0]?.n ?? 0)} />
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi etiqueta="Contactados" valor={String(nContactados)} nota="mensajes enviados" />
        <Kpi
          etiqueta="Tasa de respuesta"
          valor={pct(nRespuestas, nContactados)}
          nota={`${nRespuestas} contestaron`}
        />
        <Kpi
          etiqueta="Tasa de cualificación"
          valor={pct(nCualificados, nRespuestas)}
          nota={`${nCualificados} cualificados`}
        />
        <Kpi etiqueta="Reuniones" valor={String(nReuniones)} nota="agendadas" />
        <Kpi
          etiqueta="Coste del modelo"
          valor={costeUsd ? `${costeUsd.toFixed(2)} $` : '—'}
          nota="OpenRouter, coste real"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="border border-linea bg-lienzo p-4">
          <h2 className="etiqueta">Embudo</h2>
          <ul className="mt-3 space-y-2">
            {EMBUDO.map(({ estado, etiqueta }) => {
              const n = conteo.get(estado) ?? 0
              return (
                <li key={estado} className="grid grid-cols-[9rem_1fr_3rem] items-center gap-3">
                  <Link href={`/leads?estado=${estado}`} className="text-sm text-apagado hover:text-tinta">
                    {etiqueta}
                  </Link>
                  <span className="h-5 bg-papel">
                    <span className="block h-full bg-ensayo" style={{ width: `${(n / maximo) * 100}%` }} />
                  </span>
                  <span className="text-right font-mono text-sm">{n}</span>
                </li>
              )
            })}
          </ul>
        </section>

        <section className="border border-linea bg-lienzo p-4">
          <h2 className="etiqueta">Salidas</h2>
          <ul className="mt-3 space-y-2">
            {SALIDAS.map(({ estado, etiqueta }) => (
              <li key={estado} className="flex items-center justify-between">
                <Link href={`/leads?estado=${estado}`} className="text-sm text-apagado hover:text-tinta">
                  {etiqueta}
                </Link>
                <span className={`font-mono text-sm ${estado === 'revision_humana' && (conteo.get(estado) ?? 0) > 0 ? 'text-aviso' : ''}`}>
                  {conteo.get(estado) ?? 0}
                </span>
              </li>
            ))}
          </ul>
          {(conteo.get('revision_humana') ?? 0) > 0 && (
            <p className="mt-4 border-l-2 border-aviso bg-papel px-3 py-2 text-xs text-aviso">
              Hay leads esperándote. El agente no los va a tocar.
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
