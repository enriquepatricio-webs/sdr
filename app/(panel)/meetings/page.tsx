import Link from 'next/link'
import { desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { leads, meetings } from '@/lib/db/schema'

export const dynamic = 'force-dynamic'

const COLOR: Record<string, string> = {
  booked: 'text-ok',
  completed: 'text-apagado',
  cancelled: 'text-tenue',
  no_show: 'text-vivo',
}

export default async function PaginaReuniones() {
  const filas = await db
    .select({ reunion: meetings, lead: leads })
    .from(meetings)
    .innerJoin(leads, eq(meetings.leadId, leads.id))
    .orderBy(desc(meetings.startAt))
    .limit(200)

  const ahora = Date.now()
  const proximas = filas.filter((f) => f.reunion.startAt.getTime() >= ahora).reverse()
  const pasadas = filas.filter((f) => f.reunion.startAt.getTime() < ahora)

  function Lista({ titulo, items }: { titulo: string; items: typeof filas }) {
    if (!items.length) return null
    return (
      <section>
        <h2 className="etiqueta">{titulo}</h2>
        <ul className="mt-2 divide-y divide-linea border border-linea bg-lienzo">
          {items.map(({ reunion, lead }) => (
            <li key={reunion.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
              <div className="w-44 shrink-0">
                <p className="font-mono text-sm">
                  {reunion.startAt.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}
                  {' · '}
                  {reunion.startAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
                </p>
                <p className="text-[11px] text-tenue">
                  {Math.round((reunion.endAt.getTime() - reunion.startAt.getTime()) / 60000)} min
                </p>
              </div>
              <div className="min-w-0 flex-1">
                <Link href={`/leads/${lead.id}`} className="font-medium hover:text-ensayo">
                  {lead.fullName}
                </Link>
                <p className="truncate text-xs text-tenue">
                  {lead.headline ?? lead.company ?? ''}
                  {lead.score !== null && ` · score ${lead.score}`}
                </p>
              </div>
              {reunion.meetUrl && (
                <a href={reunion.meetUrl} target="_blank" rel="noreferrer" className="text-sm text-ensayo underline">
                  Meet
                </a>
              )}
              <span className={`w-24 text-right font-mono text-[11px] uppercase ${COLOR[reunion.status]}`}>
                {reunion.status.replace('_', ' ')}
              </span>
            </li>
          ))}
        </ul>
      </section>
    )
  }

  return (
    <div className="space-y-8">
      <header>
        <p className="etiqueta">Reuniones</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          {proximas.length} por delante
        </h1>
      </header>

      {filas.length === 0 ? (
        <div className="border border-dashed border-linea-fuerte p-10 text-center">
          <p className="text-sm text-tenue">Todavía no hay ninguna reunión agendada.</p>
        </div>
      ) : (
        <>
          <Lista titulo="Próximas" items={proximas} />
          <Lista titulo="Pasadas" items={pasadas} />
        </>
      )}
    </div>
  )
}
