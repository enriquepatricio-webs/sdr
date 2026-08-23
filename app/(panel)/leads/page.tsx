import Link from 'next/link'
import { and, asc, count, desc, eq, gte, ilike, or, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db'
import { campaigns, leadStatusEnum, leads } from '@/lib/db/schema'
import { Importador } from './importador'
import { Filtros } from './filtros'
import { workspaceActivo } from '@/lib/workspace'

export const dynamic = 'force-dynamic'

const POR_PAGINA = 50

export default async function PaginaLeads({
  searchParams,
}: {
  searchParams: Promise<{ estado?: string; campana?: string; score?: string; q?: string; p?: string }>
}) {
  const sp = await searchParams
  const pagina = Math.max(1, Number(sp.p) || 1)

  // Los leads son de una empresa. Sin este filtro, con dos clientes conectados
  // la lista los mezcla y acabas escribiéndole al prospecto de uno desde la
  // cuenta del otro.
  const empresa = await workspaceActivo()

  const condiciones: SQL[] = []
  if (empresa) condiciones.push(eq(campaigns.workspaceId, empresa.id))
  if (sp.estado && leadStatusEnum.enumValues.includes(sp.estado as never)) {
    condiciones.push(eq(leads.status, sp.estado as (typeof leadStatusEnum.enumValues)[number]))
  }
  if (sp.campana) condiciones.push(eq(leads.campaignId, sp.campana))
  if (sp.score) condiciones.push(gte(leads.score, Number(sp.score)))
  if (sp.q) {
    const patron = `%${sp.q}%`
    condiciones.push(
      or(ilike(leads.fullName, patron), ilike(leads.company, patron), ilike(leads.headline, patron))!,
    )
  }
  const filtro = condiciones.length ? and(...condiciones) : undefined

  const [filas, [{ n: total } = { n: 0 }], listaCampanas] = await Promise.all([
    db
      .select({ lead: leads, campana: campaigns })
      .from(leads)
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(filtro)
      .orderBy(desc(leads.updatedAt))
      .limit(POR_PAGINA)
      .offset((pagina - 1) * POR_PAGINA),
    db
      .select({ n: count() })
      .from(leads)
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(filtro),
    db
      .select({ id: campaigns.id, name: campaigns.name, channel: campaigns.channel })
      .from(campaigns)
      .where(empresa ? eq(campaigns.workspaceId, empresa.id) : undefined)
      .orderBy(asc(campaigns.createdAt)),
  ])

  const paginas = Math.ceil(Number(total) / POR_PAGINA)
  const qs = (cambios: Record<string, string | undefined>) => {
    const p = new URLSearchParams(
      Object.entries({ ...sp, ...cambios }).filter(([, v]) => v) as [string, string][],
    )
    return `/leads?${p}`
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="etiqueta">Pipeline</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            {Number(total).toLocaleString('es-ES')} {Number(total) === 1 ? 'lead' : 'leads'}
          </h1>
        </div>
        <Importador campanas={listaCampanas} />
      </header>

      <Filtros campanas={listaCampanas} actuales={sp} />

      {filas.length === 0 ? (
        <div className="border border-dashed border-linea-fuerte p-10 text-center">
          <p className="text-sm text-tenue">
            Ningún lead con esos filtros. Importa un CSV o{' '}
            <Link href="/prospectar" className="text-ensayo underline">busca prospectos</Link>.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-linea bg-lienzo">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-b border-linea text-left">
                {['Nombre', 'Empresa', 'Campaña', 'Estado', 'Score', 'Toques', 'Próxima acción'].map(
                  (h) => (
                    <th key={h} className="px-3 py-2 etiqueta font-normal">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-linea">
              {filas.map(({ lead, campana }) => (
                <tr key={lead.id} className="hover:bg-papel">
                  <td className="px-3 py-2">
                    <Link href={`/leads/${lead.id}`} className="font-medium hover:text-ensayo">
                      {lead.fullName}
                    </Link>
                    {lead.headline && (
                      <p className="max-w-xs truncate text-xs text-tenue">{lead.headline}</p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-apagado">{lead.company ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-tenue">{campana.name}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`font-mono text-[11px] uppercase ${
                        lead.status === 'agendado'
                          ? 'text-ok'
                          : lead.status === 'revision_humana'
                            ? 'text-aviso'
                            : lead.status === 'error'
                              ? 'text-vivo'
                              : 'text-apagado'
                      }`}
                    >
                      {lead.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono">{lead.score ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-tenue">{lead.touchCount}</td>
                  <td className="px-3 py-2 text-xs text-tenue">
                    {lead.nextActionAt
                      ? new Date(lead.nextActionAt).toLocaleString('es-ES', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {paginas > 1 && (
        <nav className="flex items-center gap-3" aria-label="Paginación">
          {pagina > 1 && (
            <Link href={qs({ p: String(pagina - 1) })} className="etiqueta hover:text-tinta">
              ← Anterior
            </Link>
          )}
          <span className="font-mono text-xs text-tenue">
            {pagina} / {paginas}
          </span>
          {pagina < paginas && (
            <Link href={qs({ p: String(pagina + 1) })} className="etiqueta hover:text-tinta">
              Siguiente →
            </Link>
          )}
        </nav>
      )}
    </div>
  )
}
