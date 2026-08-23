import { and, asc, count, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { accounts, leadMagnets, magnetContacts, magnetStateEnum } from '@/lib/db/schema'
import { ajustesEfectivos, workspaceActivo } from '@/lib/workspace'
import { Imanes } from './imanes'

export const dynamic = 'force-dynamic'

export default async function PaginaImanes() {
  // La empresa que el usuario tiene seleccionada en la cabecera, no siempre la
  // primera: un imán cuelga de una cuenta de Instagram concreta.
  const ws = await workspaceActivo()
  const ajustes = await ajustesEfectivos(ws?.id)

  if (!ws) {
    return (
      <div className="border border-dashed border-linea-fuerte p-10 text-center">
        <p className="text-sm text-tenue">Da de alta una empresa antes de crear un imán.</p>
      </div>
    )
  }

  const [imanes, cuentas] = await Promise.all([
    db
      .select({ iman: leadMagnets, cuenta: accounts.displayName })
      .from(leadMagnets)
      .innerJoin(accounts, eq(leadMagnets.accountId, accounts.id))
      .where(eq(leadMagnets.workspaceId, ws.id))
      .orderBy(asc(leadMagnets.createdAt)),
    db
      .select({ id: accounts.id, displayName: accounts.displayName, status: accounts.status })
      .from(accounts)
      .where(and(eq(accounts.provider, 'instagram'), eq(accounts.workspaceId, ws.id)))
      .orderBy(asc(accounts.createdAt)),
  ])

  const ids = imanes.map((f) => f.iman.id)
  const [conteos, contactos] = ids.length
    ? await Promise.all([
        db
          .select({ magnetId: magnetContacts.magnetId, state: magnetContacts.state, n: count() })
          .from(magnetContacts)
          .where(inArray(magnetContacts.magnetId, ids))
          .groupBy(magnetContacts.magnetId, magnetContacts.state),
        db
          .select({
            id: magnetContacts.id,
            magnetId: magnetContacts.magnetId,
            username: magnetContacts.username,
            state: magnetContacts.state,
            createdAt: magnetContacts.createdAt,
          })
          .from(magnetContacts)
          .where(inArray(magnetContacts.magnetId, ids))
          .orderBy(desc(magnetContacts.createdAt))
          .limit(300),
      ])
    : [[], []]

  return (
    <Imanes
      autopilot={ajustes.autopilot}
      empresa={ws.name}
      cuentas={cuentas}
      estados={[...magnetStateEnum.enumValues]}
      imanes={imanes.map(({ iman, cuenta }) => ({
        id: iman.id,
        name: iman.name,
        keyword: iman.keyword,
        postUrl: iman.postUrl,
        active: iman.active,
        cuenta,
        lastCheckedAt: iman.lastCheckedAt?.toISOString() ?? null,
        porEstado: Object.fromEntries(
          conteos.filter((c) => c.magnetId === iman.id).map((c) => [c.state, Number(c.n)]),
        ),
        contactos: contactos
          .filter((c) => c.magnetId === iman.id)
          .map((c) => ({ id: c.id, username: c.username, state: c.state })),
      }))}
    />
  )
}
