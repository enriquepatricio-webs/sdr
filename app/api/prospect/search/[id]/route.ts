import { NextResponse } from 'next/server'
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  campaigns,
  icps,
  leads,
  normalizedEmail,
  normalizedHandle,
  normalizedLinkedinUrl,
  prospectSearches,
  prospects,
} from '@/lib/db/schema'
import { jsonError, serverError } from '@/lib/api'
import { getDatasetItems, getRun, isFinished } from '@/lib/apify'
import { normalizarCandidato, puntuarCandidatos } from '@/lib/prospect'
import { ajustesEfectivos } from '@/lib/workspace'

export const dynamic = 'force-dynamic'
// La puntuación con el LLM va por lotes y puede tardar.
export const maxDuration = 300

/**
 * Sondeo del estado de una búsqueda. Hace tres cosas según en qué punto esté:
 * informar, ingerir el resultado, o devolver los candidatos ya puntuados.
 *
 * Es idempotente: dos sondeos simultáneos no ingieren dos veces porque el paso
 * a 'puntuando' es un UPDATE condicional que solo gana uno.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const [busqueda] = await db.select().from(prospectSearches).where(eq(prospectSearches.id, id))
    if (!busqueda) return jsonError('Esa búsqueda no existe.', 404)

    if (busqueda.status === 'ejecutando' && busqueda.apifyRunId) {
      const run = await getRun(busqueda.apifyRunId)

      if (!isFinished(run.status)) {
        return NextResponse.json({ estado: 'ejecutando', apify: run.status, prospectos: [] })
      }

      if (run.status !== 'SUCCEEDED') {
        await db
          .update(prospectSearches)
          .set({
            status: 'fallida',
            error: `Apify terminó en ${run.status}. ${run.statusMessage ?? ''}`.trim(),
          })
          .where(eq(prospectSearches.id, id))
        return NextResponse.json({ estado: 'fallida', apify: run.status, prospectos: [] })
      }

      // Reclamo: solo la primera petición que consiga cambiar el estado ingiere.
      const reclamado = await db
        .update(prospectSearches)
        .set({ status: 'puntuando' })
        .where(and(eq(prospectSearches.id, id), eq(prospectSearches.status, 'ejecutando')))
        .returning({ id: prospectSearches.id })

      if (reclamado.length) {
        await ingerir(
          id,
          busqueda.icpId,
          busqueda.workspaceId,
          busqueda.source,
          run.defaultDatasetId,
          run.costUsd,
        )
      }
    }

    const [actual] = await db.select().from(prospectSearches).where(eq(prospectSearches.id, id))
    const candidatos = await db
      .select()
      .from(prospects)
      .where(eq(prospects.searchId, id))
      .orderBy(desc(prospects.icpScore), asc(prospects.fullName))

    return NextResponse.json({
      estado: actual.status,
      error: actual.error,
      stats: actual.stats,
      razonamiento: actual.inputReasoning,
      filtros: actual.input,
      prospectos: candidatos,
    })
  } catch (err) {
    return serverError(err, 'No se pudo consultar la búsqueda')
  }
}

/**
 * Identidades que el sistema ya conoce, para no volver a traerlas.
 *
 * Sin esto el reabastecimiento automático repite gente: el mismo perfil sale en
 * dos búsquedas distintas, se importa dos veces a campañas distintas y acaba
 * recibiendo dos mensajes nuestros. Los índices únicos son POR campaña y POR
 * búsqueda, así que no cubren este caso; hay que mirarlo a mano.
 */
async function identidadesConocidas(): Promise<{
  linkedin: Set<string>
  instagram: Set<string>
  email: Set<string>
}> {
  const [deLeads, deProspectos] = await Promise.all([
    db
      .select({
        li: sql<string | null>`${normalizedLinkedinUrl(leads.linkedinUrl)}`,
        ig: sql<string | null>`${normalizedHandle(leads.instagramUsername)}`,
        em: sql<string | null>`${normalizedEmail(leads.email)}`,
      })
      .from(leads),
    db
      .select({
        li: sql<string | null>`${normalizedLinkedinUrl(prospects.linkedinUrl)}`,
        ig: sql<string | null>`${normalizedHandle(prospects.instagramUsername)}`,
        em: sql<string | null>`${normalizedEmail(prospects.email)}`,
      })
      .from(prospects),
  ])

  const linkedin = new Set<string>()
  const instagram = new Set<string>()
  const email = new Set<string>()
  for (const f of [...deLeads, ...deProspectos]) {
    if (f.li) linkedin.add(f.li)
    if (f.ig) instagram.add(f.ig)
    if (f.em) email.add(f.em)
  }
  return { linkedin, instagram, email }
}

function normalizarLi(url: string | null): string | null {
  return url ? url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '') : null
}

async function ingerir(
  searchId: string,
  icpId: string,
  workspaceId: string | null,
  source: 'linkedin' | 'email' | 'instagram',
  datasetId: string,
  costeApify: number | null,
) {
  const [icp] = await db.select().from(icps).where(eq(icps.id, icpId))
  // El umbral de auto-importación es el de ESA empresa: cada una decide a partir
  // de qué puntuación un candidato entra solo en su campaña.
  const ajustes = await ajustesEfectivos(workspaceId)

  const crudos = await getDatasetItems(datasetId, { limit: 500 })
  const conocidas = await identidadesConocidas()

  const todos = crudos
    .map((item) => normalizarCandidato(source === 'instagram' ? 'instagram' : 'linkedin', item))
    .filter((c): c is NonNullable<typeof c> => c !== null)

  // Fuera los que ya están en el sistema: puntuarlos cuesta dinero y no aportan.
  const normalizados = todos.filter((c) => {
    const li = normalizarLi(c.linkedinUrl)
    const ig = c.instagramUsername?.toLowerCase().replace(/^@/, '').trim()
    const em = c.email?.toLowerCase()
    if (li && conocidas.linkedin.has(li)) return false
    if (ig && conocidas.instagram.has(ig)) return false
    if (em && conocidas.email.has(em)) return false
    return true
  })

  const yaConocidos = todos.length - normalizados.length

  const { puntuaciones, costeUsd } = normalizados.length
    ? await puntuarCandidatos(icp, normalizados, ajustes.openrouterModel)
    : { puntuaciones: new Map(), costeUsd: 0 }

  let encajan = 0
  let descartados = 0

  if (normalizados.length) {
    const filas = normalizados.map((c, i) => {
      const p = puntuaciones.get(i)
      if (p?.verdict === 'encaja') encajan++
      if (p?.verdict === 'no_encaja') descartados++
      return {
        searchId,
        fullName: c.fullName,
        headline: c.headline,
        company: c.company,
        location: c.location,
        linkedinUrl: c.linkedinUrl,
        instagramUsername: c.instagramUsername,
        email: c.email,
        providerId: c.providerId,
        icpScore: p?.score ?? null,
        icpVerdict: p?.verdict ?? null,
        icpReasoning: p?.reasoning ?? null,
        raw: c.raw,
      }
    })

    // Un actor devuelve duplicados con frecuencia; los índices únicos por
    // búsqueda los rechazan y aquí simplemente se ignoran.
    await db.insert(prospects).values(filas).onConflictDoNothing()
  }

  const previo = (await db.select().from(prospectSearches).where(eq(prospectSearches.id, searchId)))[0]

  /**
   * Auto-importación.
   *
   * Solo en búsquedas del reabastecimiento automático (`autoImport`), solo por
   * encima del umbral configurado y solo con veredicto "encaja". Todo lo demás
   * se queda en la sala de espera para que lo mire una persona.
   *
   * Esto mete leads en la campaña; NO autoriza a enviarles nada. Cuántos
   * mensajes salen lo sigue decidiendo el cupo de /api/leads/next.
   */
  let autoImportados = 0
  if (previo?.autoImport && previo.campaignId) {
    const [campana] = await db.select().from(campaigns).where(eq(campaigns.id, previo.campaignId))
    if (campana) {
      const candidatos = await db
        .select()
        .from(prospects)
        .where(
          and(
            eq(prospects.searchId, searchId),
            eq(prospects.decision, 'pendiente'),
            eq(prospects.icpVerdict, 'encaja'),
            gte(prospects.icpScore, ajustes.autoProspectMinScore),
          ),
        )

      for (const c of candidatos) {
        const identificador =
          campana.channel === 'instagram'
            ? c.instagramUsername
            : campana.channel === 'email'
              ? c.email
              : (c.linkedinUrl ?? c.providerId)
        if (!identificador) continue

        const [lead] = await db
          .insert(leads)
          .values({
            campaignId: campana.id,
            fullName: c.fullName,
            headline: c.headline,
            company: c.company,
            linkedinUrl: c.linkedinUrl,
            instagramUsername: c.instagramUsername,
            email: c.email,
            providerId: c.providerId,
            status: 'nuevo',
            raw: { ...c.raw, origen: 'reabastecimiento', prospect_id: c.id, icp_score: c.icpScore },
          })
          .onConflictDoNothing()
          .returning({ id: leads.id })

        if (!lead) continue
        await db
          .update(prospects)
          .set({ decision: 'importado', leadId: lead.id })
          .where(eq(prospects.id, c.id))
        autoImportados++
      }
    }
  }

  await db
    .update(prospectSearches)
    .set({
      status: 'completada',
      stats: {
        encontrados: crudos.length,
        yaConocidos,
        autoImportados,
        puntuados: puntuaciones.size,
        encajan,
        descartados,
        coste_apify_usd: costeApify ?? undefined,
        coste_llm_usd: (previo?.stats?.coste_llm_usd ?? 0) + costeUsd,
      },
    })
    .where(eq(prospectSearches.id, searchId))
}
