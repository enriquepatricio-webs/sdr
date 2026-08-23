import { count, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { campaigns } from '@/lib/db/schema'
import { ajustesEfectivos, workspaceActivo } from '@/lib/workspace'
import { Ajustes } from './ajustes'

export const dynamic = 'force-dynamic'

export default async function PaginaAjustes() {
  const empresa = await workspaceActivo()
  const [ajustes, activas] = await Promise.all([
    ajustesEfectivos(empresa?.id),
    db.select({ n: count() }).from(campaigns).where(eq(campaigns.status, 'running')),
  ])

  return (
    // Igual que en /empresa: al cambiar de empresa hay que remontar, o los
    // interruptores se quedan enseñando el estado de la anterior.
    <Ajustes
      key={ajustes.workspace?.id ?? 'sin-empresa'}
      ajustes={{
        ...ajustes,
        workspace: ajustes.workspace && { id: ajustes.workspace.id, name: ajustes.workspace.name },
      }}
      campanasActivas={Number(activas[0]?.n ?? 0)}
      tieneTelegramEnv={Boolean(process.env.TELEGRAM_CHAT_ID)}
    />
  )
}
