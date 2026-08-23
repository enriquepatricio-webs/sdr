import Link from 'next/link'
import { notFound } from 'next/navigation'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { accounts, campaigns, icps, playbooks } from '@/lib/db/schema'
import { DetalleCampana } from './detalle'

export const dynamic = 'force-dynamic'

export default async function PaginaCampana({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [campana] = await db.select().from(campaigns).where(eq(campaigns.id, id))
  if (!campana) notFound()

  const [listaCuentas, listaPlaybooks, listaIcps] = await Promise.all([
    db
      .select({ id: accounts.id, displayName: accounts.displayName, provider: accounts.provider, status: accounts.status })
      .from(accounts)
      .orderBy(asc(accounts.createdAt)),
    db
      .select({ id: playbooks.id, name: playbooks.name, version: playbooks.version, isActive: playbooks.isActive })
      .from(playbooks)
      .orderBy(asc(playbooks.version)),
    db.select({ id: icps.id, name: icps.name }).from(icps).orderBy(asc(icps.createdAt)),
  ])

  return (
    <div className="space-y-6">
      <Link href="/campaigns" className="etiqueta hover:text-tinta">← Campañas</Link>
      <DetalleCampana
        campana={{ ...campana, createdAt: campana.createdAt.toISOString() }}
        cuentas={listaCuentas}
        playbooks={listaPlaybooks}
        icps={listaIcps}
      />
    </div>
  )
}
