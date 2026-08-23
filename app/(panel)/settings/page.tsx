import { asc } from 'drizzle-orm'
import { db } from '@/lib/db'
import { accounts } from '@/lib/db/schema'
import { getSettings } from '@/lib/settings'
import { Ajustes } from './ajustes'

export const dynamic = 'force-dynamic'

export default async function PaginaAjustes() {
  const [lista, ajustes] = await Promise.all([
    db.select().from(accounts).orderBy(asc(accounts.createdAt)),
    getSettings(),
  ])

  return (
    <Ajustes
      cuentas={lista.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() }))}
      ajustes={ajustes}
      tieneTelegramEnv={Boolean(process.env.TELEGRAM_CHAT_ID)}
    />
  )
}
