import { asc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sellers } from '@/lib/db/schema'
import { EditorEmpresas } from './editor'

export const dynamic = 'force-dynamic'

export default async function PaginaEmpresa() {
  const lista = await db.select().from(sellers).orderBy(asc(sellers.name))
  return (
    <EditorEmpresas
      inicial={lista.map((e) => ({
        ...e,
        scrapedAt: e.scrapedAt?.toISOString() ?? null,
        createdAt: e.createdAt.toISOString(),
      }))}
    />
  )
}
