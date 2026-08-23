import { asc, eq, isNull, or } from 'drizzle-orm'
import { db } from '@/lib/db'
import { accounts } from '@/lib/db/schema'
import { workspaceActivo } from '@/lib/workspace'
import { EditorEmpresa } from './editor'

export const dynamic = 'force-dynamic'

export default async function PaginaEmpresa() {
  const empresa = await workspaceActivo()

  // Las cuentas sin empresa salen aquí también. Ya no se crean así, pero las de
  // antes siguen existiendo y son INSERVIBLES: la clave ajena compuesta impide
  // que una campaña las use. Esconderlas sería esconder el problema.
  const cuentas = empresa
    ? await db
        .select()
        .from(accounts)
        .where(or(eq(accounts.workspaceId, empresa.id), isNull(accounts.workspaceId)))
        .orderBy(asc(accounts.createdAt))
    : []

  return (
    // `key` fuerza el remontaje al cambiar de empresa. El formulario guarda lo
    // escrito en estado local, y sin esto seguiría enseñando los datos de la
    // empresa anterior después de cambiar en la cabecera.
    <EditorEmpresa
      key={empresa?.id ?? 'sin-empresa'}
      empresaId={empresa?.id ?? null}
      empresa={
        empresa && {
          id: empresa.id,
          name: empresa.name,
          website: empresa.website,
          context: empresa.context,
          offer: empresa.offer,
          scrapedAt: empresa.scrapedAt?.toISOString() ?? null,
          caracteresLeidos: empresa.scrapedContext?.length ?? 0,
        }
      }
      cuentas={cuentas.map((c) => ({
        id: c.id,
        provider: c.provider,
        displayName: c.displayName,
        status: c.status,
        hourlyLimit: c.hourlyLimit,
        huerfana: c.workspaceId === null,
      }))}
    />
  )
}
