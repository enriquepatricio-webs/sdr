import { asc, desc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { campaigns, icps, prospectSearches } from '@/lib/db/schema'
import { Prospeccion } from './prospeccion'

export const dynamic = 'force-dynamic'

export default async function PaginaProspectar() {
  const [listaIcps, listaCampanas, busquedas] = await Promise.all([
    db.select({ id: icps.id, name: icps.name }).from(icps).orderBy(asc(icps.createdAt)),
    db
      .select({ id: campaigns.id, name: campaigns.name, channel: campaigns.channel })
      .from(campaigns)
      .orderBy(asc(campaigns.createdAt)),
    db
      .select({
        id: prospectSearches.id,
        name: prospectSearches.name,
        source: prospectSearches.source,
        status: prospectSearches.status,
        stats: prospectSearches.stats,
        createdAt: prospectSearches.createdAt,
      })
      .from(prospectSearches)
      .orderBy(desc(prospectSearches.createdAt))
      .limit(20),
  ])

  return (
    <Prospeccion
      icps={listaIcps}
      campanas={listaCampanas}
      busquedas={busquedas.map((b) => ({ ...b, createdAt: b.createdAt.toISOString() }))}
    />
  )
}
