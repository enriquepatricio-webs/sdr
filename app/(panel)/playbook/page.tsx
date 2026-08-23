import { asc, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { icps, playbooks } from '@/lib/db/schema'
import { EditorPlaybook } from './editor'

export const dynamic = 'force-dynamic'

export default async function PaginaPlaybook() {
  const [activo] = await db.select().from(playbooks).where(eq(playbooks.isActive, true))

  const [historial, listaIcps] = await Promise.all([
    db
      .select({
        id: playbooks.id,
        name: playbooks.name,
        version: playbooks.version,
        isActive: playbooks.isActive,
        createdAt: playbooks.createdAt,
      })
      .from(playbooks)
      .orderBy(desc(playbooks.version)),
    db.select({ id: icps.id, name: icps.name }).from(icps).orderBy(asc(icps.createdAt)),
  ])

  if (!activo) {
    return (
      <div className="max-w-lg border border-linea bg-lienzo p-8">
        <p className="etiqueta">Sin playbook</p>
        <h1 className="mt-2 text-2xl font-semibold">No hay ningún playbook activo</h1>
        <p className="mt-3 text-apagado">
          Carga los datos de ejemplo con <code className="font-mono text-tinta">npm run db:seed</code>{' '}
          y vuelve aquí.
        </p>
      </div>
    )
  }

  return (
    <EditorPlaybook
      inicial={activo}
      historial={historial.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() }))}
      icps={listaIcps}
    />
  )
}
