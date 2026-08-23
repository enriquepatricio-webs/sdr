import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { icps, prospectSearches } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'
import { SUPPORTED_ACTORS, startRun } from '@/lib/apify'
import { traducirIcpAFiltros } from '@/lib/prospect'
import { getSettings } from '@/lib/settings'

export const dynamic = 'force-dynamic'
// Solo se traduce el ICP y se arranca el run: no se espera al scraping.
export const maxDuration = 120

export async function GET() {
  try {
    const busquedas = await db
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
      .limit(50)
    return NextResponse.json({ busquedas })
  } catch (err) {
    return serverError(err, 'No se pudieron leer las búsquedas')
  }
}

const cuerpo = z.object({
  icpId: z.string().uuid(),
  source: z.enum(['linkedin', 'instagram']),
  name: z.string().min(1),
  brief: z.string().max(2000).optional(),
  /** Tope de gasto. Lo pone la persona, nunca el modelo. */
  maxItems: z.number().int().min(1).max(500).default(50),
  campaignId: z.string().uuid().optional(),
})

/**
 * Arranca una búsqueda y vuelve enseguida.
 *
 * No se espera al resultado a propósito: un scraping de perfiles tarda entre uno
 * y diez minutos y una función de Vercel tiene 300 s. Se guarda el runId y el
 * dashboard sondea /api/prospect/search/[id].
 */
export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  const d = body.data

  try {
    const [icp] = await db.select().from(icps).where(eq(icps.id, d.icpId))
    if (!icp) return jsonError('Ese ICP no existe.', 404)

    const ajustes = await getSettings()
    const actor = SUPPORTED_ACTORS[d.source].actor

    const filtros = await traducirIcpAFiltros(icp, d.source, d.brief ?? null, ajustes.openrouterModel)

    // El tope lo añadimos nosotros después de la traducción: así el modelo no
    // puede subirlo aunque se lo pidan en el brief.
    const input =
      d.source === 'linkedin'
        ? { ...filtros.input, maxItems: d.maxItems, profileScraperMode: 'Short' }
        : { ...filtros.input, resultsType: 'details', searchLimit: d.maxItems }

    const [busqueda] = await db
      .insert(prospectSearches)
      .values({
        icpId: d.icpId,
        campaignId: d.campaignId,
        name: d.name,
        source: d.source,
        brief: d.brief,
        actor,
        input,
        inputReasoning: filtros.razonamiento,
        status: 'pendiente',
        stats: {
          encontrados: 0,
          puntuados: 0,
          encajan: 0,
          descartados: 0,
          coste_llm_usd: filtros.usage.cost ?? 0,
        },
      })
      .returning({ id: prospectSearches.id })

    try {
      const run = await startRun(actor, input, { maxItems: d.maxItems })
      await db
        .update(prospectSearches)
        .set({ apifyRunId: run.id, apifyDatasetId: run.defaultDatasetId, status: 'ejecutando' })
        .where(eq(prospectSearches.id, busqueda.id))

      return NextResponse.json({ id: busqueda.id, runId: run.id, razonamiento: filtros.razonamiento, input })
    } catch (err) {
      // La búsqueda queda registrada con el error: si no, desaparece sin rastro
      // y no hay forma de saber qué filtros se intentaron.
      await db
        .update(prospectSearches)
        .set({ status: 'fallida', error: err instanceof Error ? err.message : String(err) })
        .where(eq(prospectSearches.id, busqueda.id))
      throw err
    }
  } catch (err) {
    return serverError(err, 'No se pudo arrancar la búsqueda')
  }
}
