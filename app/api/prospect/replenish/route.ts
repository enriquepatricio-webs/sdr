import { NextResponse } from 'next/server'
import { and, count, desc, eq, gte, isNotNull, ne } from 'drizzle-orm'
import { db } from '@/lib/db'
import { campaigns, icps, leads, prospectSearches, runLogs } from '@/lib/db/schema'
import { serverError } from '@/lib/api'
import { SUPPORTED_ACTORS, startRun } from '@/lib/apify'
import { traducirIcpAFiltros } from '@/lib/prospect'
import { planificarReabastecimiento } from '@/lib/replenish'
import { getSettings } from '@/lib/settings'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Rellena la cola de leads cuando se está quedando vacía.
 *
 * Lo llama n8n en cada vuelta de W1. La idea es que el sistema no se pare nunca:
 * si una campaña en marcha se queda sin leads, busca más él solo.
 *
 * Dos frenos, y ninguno es opcional:
 *
 *  · GASTO — hay un tope de búsquedas automáticas al día. Cada una cuesta dinero
 *    en Apify y en el modelo, y un cron cada 30 minutos sin tope sería una
 *    factura sorpresa a fin de mes.
 *
 *  · ENVÍO — este endpoint NO toca los topes de envío. Llenar la cola de leads
 *    no autoriza ni un mensaje más: eso lo decide /api/leads/next con el cupo
 *    por cuenta, por campaña y por hora. Tener diez mil leads produce los mismos
 *    25 mensajes al día que tener diez.
 *
 * Y una campaña pausada nunca se reabastece: si has echado el freno de mano, el
 * sistema no puede rearmarse solo.
 */
export async function POST() {
  try {
    const ajustes = await getSettings()

    const inicioDelDia = new Date()
    inicioDelDia.setHours(0, 0, 0, 0)

    const [estados, [{ n: busquedasHoy } = { n: 0 }]] = await Promise.all([
      db
        .select({
          id: campaigns.id,
          name: campaigns.name,
          status: campaigns.status,
          icpId: campaigns.icpId,
          channel: campaigns.channel,
          leadsPendientes: count(leads.id),
        })
        .from(campaigns)
        .leftJoin(leads, and(eq(leads.campaignId, campaigns.id), eq(leads.status, 'nuevo')))
        .groupBy(campaigns.id),
      db
        .select({ n: count() })
        .from(prospectSearches)
        .where(
          and(
            eq(prospectSearches.origin, 'automatica'),
            gte(prospectSearches.createdAt, inicioDelDia),
          ),
        ),
    ])

    const plan = planificarReabastecimiento({
      activo: ajustes.autoProspect,
      campanas: estados.map((c) => ({ ...c, leadsPendientes: Number(c.leadsPendientes) })),
      busquedasAutomaticasHoy: Number(busquedasHoy),
      maxBusquedasDia: ajustes.autoProspectMaxSearchesPerDay,
      minLeads: ajustes.autoProspectMinLeads,
    })

    if (!plan.procede) {
      return NextResponse.json({ lanzadas: 0, motivo: plan.motivo, detalle: plan.detalle })
    }

    const lanzadas: { campana: string; busquedaId: string; angulo: string }[] = []

    for (const objetivo of plan.campanas) {
      const campana = estados.find((c) => c.id === objetivo.id)!
      const fuente = campana.channel === 'instagram' ? 'instagram' : 'linkedin'

      const [icp] = await db.select().from(icps).where(eq(icps.id, objetivo.icpId))
      if (!icp) continue

      // Ángulos ya probados con este ICP: el modelo tiene que traer otro.
      const previos = await db
        .select({ angle: prospectSearches.angle })
        .from(prospectSearches)
        .where(and(eq(prospectSearches.icpId, icp.id), isNotNull(prospectSearches.angle)))
        .orderBy(desc(prospectSearches.createdAt))
        .limit(15)

      const filtros = await traducirIcpAFiltros(
        icp,
        fuente,
        null,
        ajustes.openrouterModel,
        previos.map((p) => p.angle!).filter(Boolean),
      )

      const actor = SUPPORTED_ACTORS[fuente].actor
      const input =
        fuente === 'linkedin'
          ? {
              ...filtros.input,
              maxItems: ajustes.autoProspectMaxItems,
              profileScraperMode: 'Short',
            }
          : {
              ...filtros.input,
              resultsType: 'details',
              searchLimit: ajustes.autoProspectMaxItems,
            }

      const [busqueda] = await db
        .insert(prospectSearches)
        .values({
          icpId: icp.id,
          campaignId: campana.id,
          name: `Auto · ${filtros.angulo}`,
          source: fuente,
          origin: 'automatica',
          angle: filtros.angulo,
          // Solo el reabastecimiento importa solo, y solo por encima del umbral.
          autoImport: true,
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
        const run = await startRun(actor, input, { maxItems: ajustes.autoProspectMaxItems })
        await db
          .update(prospectSearches)
          .set({ apifyRunId: run.id, apifyDatasetId: run.defaultDatasetId, status: 'ejecutando' })
          .where(eq(prospectSearches.id, busqueda.id))

        lanzadas.push({ campana: campana.name, busquedaId: busqueda.id, angulo: filtros.angulo })
      } catch (err) {
        await db
          .update(prospectSearches)
          .set({ status: 'fallida', error: err instanceof Error ? err.message : String(err) })
          .where(eq(prospectSearches.id, busqueda.id))
      }
    }

    await db.insert(runLogs).values({
      workflow: 'sdr-reabastecer',
      level: 'info',
      message: `Reabastecimiento: ${lanzadas.length} búsquedas lanzadas`,
      payload: { lanzadas, busquedasHoy: Number(busquedasHoy) },
    })

    return NextResponse.json({ lanzadas: lanzadas.length, busquedas: lanzadas })
  } catch (err) {
    return serverError(err, 'No se pudo reabastecer')
  }
}

/** Estado del reabastecimiento, para el panel. */
export async function GET() {
  try {
    const ajustes = await getSettings()
    const inicioDelDia = new Date()
    inicioDelDia.setHours(0, 0, 0, 0)

    const [[{ n: hoy } = { n: 0 }], enMarcha] = await Promise.all([
      db
        .select({ n: count() })
        .from(prospectSearches)
        .where(
          and(
            eq(prospectSearches.origin, 'automatica'),
            gte(prospectSearches.createdAt, inicioDelDia),
          ),
        ),
      db
        .select({ n: count() })
        .from(prospectSearches)
        .where(ne(prospectSearches.status, 'completada')),
    ])

    return NextResponse.json({
      activo: ajustes.autoProspect,
      busquedasHoy: Number(hoy),
      maxDia: ajustes.autoProspectMaxSearchesPerDay,
      enCurso: Number(enMarcha[0]?.n ?? 0),
    })
  } catch (err) {
    return serverError(err, 'No se pudo leer el estado del reabastecimiento')
  }
}
