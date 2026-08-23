import Link from 'next/link'
import { asc, count, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { accounts, campaigns, leads } from '@/lib/db/schema'
import { dentroDeVentana } from '@/lib/sending-window'

export const dynamic = 'force-dynamic'

const COLOR: Record<string, string> = {
  running: 'text-ok',
  paused: 'text-aviso',
  draft: 'text-tenue',
  done: 'text-tenue',
}

export default async function PaginaCampanas() {
  const filas = await db
    .select({ campana: campaigns, cuenta: accounts, leads: count(leads.id) })
    .from(campaigns)
    .leftJoin(accounts, eq(campaigns.accountId, accounts.id))
    .leftJoin(leads, eq(leads.campaignId, campaigns.id))
    .groupBy(campaigns.id, accounts.id)
    .orderBy(asc(campaigns.createdAt))

  const ahora = new Date()

  return (
    <div className="space-y-6">
      <header>
        <p className="etiqueta">Campañas</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{filas.length} campañas</h1>
      </header>

      {filas.length === 0 ? (
        <div className="border border-dashed border-linea-fuerte p-10 text-center">
          <p className="text-sm text-tenue">
            No hay campañas. Carga el ejemplo con <code className="font-mono">npm run db:seed</code>.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-linea border border-linea bg-lienzo">
          {filas.map(({ campana, cuenta, leads: n }) => {
            const abierta = dentroDeVentana(campana.sendingWindow, ahora)
            return (
              <li key={campana.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/campaigns/${campana.id}`} className="font-medium hover:text-ensayo">
                    {campana.name}
                  </Link>
                  <p className="text-xs text-tenue">
                    {campana.channel} · {cuenta?.displayName ?? 'sin cuenta'} · tope{' '}
                    {campana.dailyCap}/día · {campana.sendingWindow.from}–{campana.sendingWindow.to}{' '}
                    {campana.sendingWindow.tz}
                  </p>
                </div>
                <span className="font-mono text-sm text-tenue">{Number(n)} leads</span>
                {campana.status === 'running' && (
                  <span className={`font-mono text-[11px] uppercase ${abierta ? 'text-ok' : 'text-tenue'}`}>
                    {abierta ? 'enviando' : 'fuera de ventana'}
                  </span>
                )}
                <span className={`w-20 text-right font-mono text-[11px] uppercase ${COLOR[campana.status]}`}>
                  {campana.status}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
