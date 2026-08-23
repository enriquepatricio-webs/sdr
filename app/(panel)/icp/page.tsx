import { asc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { icps } from '@/lib/db/schema'
import { EditorIcp } from './editor'

export const dynamic = 'force-dynamic'

export default async function PaginaIcp() {
  const lista = await db.select().from(icps).orderBy(asc(icps.createdAt))
  return <EditorIcp inicial={lista.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() }))} />
}
