import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { type Enrichment, leads, runLogs } from '@/lib/db/schema'
import { jsonError, serverError } from '@/lib/api'
import { dominioProbable, leerPerfilInstagram, leerPerfilLinkedin, leerWeb } from '@/lib/scrape'
import { getSettings } from '@/lib/settings'

export const dynamic = 'force-dynamic'
// Dos scrapings en serie. Sobra con esto y no bloquea nada más.
export const maxDuration = 300

/** Se considera fresco durante dos semanas: un perfil no cambia cada día. */
const FRESCURA_DIAS = 14

/**
 * Averigua lo que se pueda del prospecto ANTES de escribirle.
 *
 * Lee su perfil y, si se puede deducir, la web de su empresa. De todo eso saca
 * un resumen corto que se inyecta en el prompt.
 *
 * Es de mejor esfuerzo por diseño: si no se puede leer nada, devuelve 200 con
 * `resumen` vacío y el agente escribe con lo que haya. Bloquear el envío porque
 * una web no responde sería peor que un mensaje algo más genérico.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const [lead] = await db.select().from(leads).where(eq(leads.id, id))
    if (!lead) return jsonError('Ese lead no existe.', 404)

    const ajustes = await getSettings()
    if (!ajustes.enrichBeforeContact) {
      return NextResponse.json({ enriquecido: false, motivo: 'desactivado', resumen: '' })
    }

    const fresco =
      lead.enrichedAt &&
      Date.now() - lead.enrichedAt.getTime() < FRESCURA_DIAS * 24 * 3600_000

    if (fresco && lead.enrichment) {
      return NextResponse.json({
        enriquecido: true,
        cacheado: true,
        resumen: lead.enrichment.resumen,
        fuentes: lead.enrichment.fuentes,
      })
    }

    const fuentes: string[] = []
    const trozos: string[] = []

    if (lead.linkedinUrl) {
      const perfil = await leerPerfilLinkedin(lead.linkedinUrl)
      if (perfil) {
        trozos.push(`PERFIL:\n${perfil.texto}`)
        fuentes.push(lead.linkedinUrl)
      }
    } else if (lead.instagramUsername) {
      const perfil = await leerPerfilInstagram(lead.instagramUsername)
      if (perfil) {
        trozos.push(`PERFIL:\n${perfil.texto}`)
        fuentes.push(`instagram.com/${lead.instagramUsername}`)
      }
    }

    // La web de su empresa: primero la que traiga el scraping del perfil, y si
    // no, el dominio obvio del nombre. Si no cuadra ninguno, se queda sin web.
    const webCandidata =
      (typeof lead.raw?.website === 'string' ? lead.raw.website : null) ??
      dominioProbable(lead.company)

    if (webCandidata) {
      const web = await leerWeb(webCandidata, { maxPaginas: 3, maxCaracteres: 4000 })
      if (web) {
        trozos.push(`SU EMPRESA (${web.url}):\n${web.texto}`)
        fuentes.push(web.url)
      }
    }

    const enrichment: Enrichment = {
      resumen: trozos.join('\n\n'),
      fuentes,
    }

    await db
      .update(leads)
      .set({ enrichment, enrichedAt: new Date() })
      .where(eq(leads.id, id))

    await db.insert(runLogs).values({
      workflow: 'sdr-enriquecer',
      leadId: id,
      level: fuentes.length ? 'info' : 'warn',
      message: fuentes.length
        ? `Enriquecido desde ${fuentes.length} fuente(s)`
        : 'No se pudo leer nada del prospecto; se escribirá con menos contexto',
      payload: { fuentes },
    })

    return NextResponse.json({
      enriquecido: fuentes.length > 0,
      cacheado: false,
      resumen: enrichment.resumen,
      fuentes,
    })
  } catch (err) {
    return serverError(err, 'No se pudo enriquecer el lead')
  }
}
