import Link from 'next/link'
import { notFound } from 'next/navigation'
import { asc, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { campaigns, leads, meetings, runLogs, touches } from '@/lib/db/schema'
import { Intervenir } from './intervenir'

export const dynamic = 'force-dynamic'

export default async function PaginaLead({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const [fila] = await db
    .select({ lead: leads, campana: campaigns })
    .from(leads)
    .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
    .where(eq(leads.id, id))

  if (!fila) notFound()
  const { lead, campana } = fila

  const [hilo, citas, registros] = await Promise.all([
    db.select().from(touches).where(eq(touches.leadId, id)).orderBy(asc(touches.createdAt)),
    db.select().from(meetings).where(eq(meetings.leadId, id)).orderBy(desc(meetings.startAt)),
    db.select().from(runLogs).where(eq(runLogs.leadId, id)).orderBy(desc(runLogs.createdAt)).limit(40),
  ])

  const q = lead.qualification

  return (
    <div className="space-y-6">
      <Link href="/leads" className="etiqueta hover:text-tinta">← Pipeline</Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{lead.fullName}</h1>
          {lead.headline && <p className="mt-1 text-apagado">{lead.headline}</p>}
          <p className="mt-1 text-sm text-tenue">
            {lead.company ?? 'sin empresa'} · {campana.name} · {campana.channel}
          </p>
          <div className="mt-2 flex flex-wrap gap-3 text-sm">
            {lead.linkedinUrl && (
              <a href={lead.linkedinUrl} target="_blank" rel="noreferrer" className="text-ensayo underline">
                LinkedIn
              </a>
            )}
            {lead.instagramUsername && (
              <a
                href={`https://instagram.com/${lead.instagramUsername}`}
                target="_blank"
                rel="noreferrer"
                className="text-ensayo underline"
              >
                @{lead.instagramUsername}
              </a>
            )}
            {lead.email && <a href={`mailto:${lead.email}`} className="text-ensayo underline">{lead.email}</a>}
          </div>
        </div>

        <div className="text-right">
          <p className="etiqueta">Estado</p>
          <p className="font-mono text-lg uppercase">{lead.status.replace('_', ' ')}</p>
          {lead.score !== null && (
            <p className="mt-1 font-mono text-3xl leading-none">{lead.score}<span className="text-sm text-tenue">/100</span></p>
          )}
          <div className="mt-3">
            <Intervenir leadId={lead.id} congelado={lead.status === 'revision_humana'} />
          </div>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* El hilo completo */}
        <section className="border border-linea bg-lienzo">
          <header className="border-b border-linea px-4 py-3">
            <h2 className="text-base font-semibold">Conversación</h2>
            <p className="text-xs text-tenue">{hilo.length} mensajes</p>
          </header>
          {hilo.length === 0 ? (
            <p className="p-6 text-center text-sm text-tenue">Todavía no se le ha escrito.</p>
          ) : (
            <ul className="space-y-3 p-4">
              {hilo.map((t) => {
                const saliente = t.direction === 'out'
                const borrador = t.status === 'borrador'
                return (
                  <li key={t.id} className={saliente ? 'flex justify-end' : 'flex justify-start'}>
                    <div className={`max-w-[80%] ${saliente ? 'text-right' : ''}`}>
                      <p
                        className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                          !saliente
                            ? 'rounded-bl-sm bg-linea text-tinta'
                            : borrador
                              ? 'rounded-br-sm border border-dashed border-ensayo bg-ensayo-suave text-tinta'
                              : t.status === 'fallido'
                                ? 'rounded-br-sm border border-vivo bg-vivo-suave text-tinta'
                                : 'rounded-br-sm border border-ensayo/30 bg-ensayo-suave text-tinta'
                        }`}
                      >
                        {t.body}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-tenue">
                        {borrador && <span className="text-ensayo">borrador · sin enviar · </span>}
                        {t.status === 'fallido' && <span className="text-vivo">falló el envío · </span>}
                        paso {t.step} ·{' '}
                        {new Date(t.sentAt ?? t.createdAt).toLocaleString('es-ES', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <div className="space-y-6">
          {/* El razonamiento del agente */}
          <section className="border border-linea bg-lienzo p-4">
            <h2 className="etiqueta">Por qué lo cualificó así</h2>
            {q ? (
              <>
                <p className="mt-2 text-sm">{q.reasoning}</p>
                {q.disqualified_by && (
                  <p className="mt-2 border-l-2 border-vivo bg-vivo-suave px-2 py-1 text-xs text-vivo">
                    Descartado por: {q.disqualified_by}
                  </p>
                )}
                {q.answers && q.answers.length > 0 && (
                  <ul className="mt-3 space-y-1.5 border-t border-linea pt-3">
                    {q.answers.map((a) => (
                      <li key={a.criterion_id} className="text-xs">
                        <span className={a.met ? 'text-ok' : 'text-tenue'}>{a.met ? '✓' : '·'}</span>{' '}
                        <span className="font-mono text-tenue">{a.criterion_id}</span> — {a.answer}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="mt-2 text-sm text-tenue">Todavía sin cualificar.</p>
            )}
          </section>

          {citas.length > 0 && (
            <section className="border border-linea bg-lienzo p-4">
              <h2 className="etiqueta">Reuniones</h2>
              <ul className="mt-2 space-y-2">
                {citas.map((m) => (
                  <li key={m.id} className="text-sm">
                    <p className="font-medium">
                      {new Date(m.startAt).toLocaleString('es-ES', { dateStyle: 'full', timeStyle: 'short' })}
                    </p>
                    <p className="font-mono text-[11px] text-tenue uppercase">{m.status}</p>
                    {m.meetUrl && (
                      <a href={m.meetUrl} target="_blank" rel="noreferrer" className="text-xs text-ensayo underline">
                        Abrir Meet
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="border border-linea bg-lienzo p-4">
            <h2 className="etiqueta">Rastro</h2>
            <ul className="mt-2 space-y-1.5">
              {registros.length === 0 && <li className="text-sm text-tenue">Sin actividad.</li>}
              {registros.map((r) => (
                <li key={r.id} className="text-xs">
                  <span className="font-mono text-tenue">
                    {new Date(r.createdAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}
                  </span>{' '}
                  <span className={r.level === 'error' ? 'text-vivo' : r.level === 'warn' ? 'text-aviso' : ''}>
                    {r.message}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
