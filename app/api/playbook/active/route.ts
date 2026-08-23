import { NextResponse } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { campaigns, icps, leads, workspaces } from '@/lib/db/schema'
import { jsonError, serverError } from '@/lib/api'
import { construirSystemPrompt } from '@/lib/agent-prompt'
import { ajustesEfectivos, playbookActivo } from '@/lib/workspace'

export const dynamic = 'force-dynamic'

/**
 * Lo que n8n carga en cada ejecución del agente.
 *
 * Con `?lead_id=` incluye además lo que se averiguó de ESE prospecto, para que
 * el mensaje pueda ser específico en vez de una plantilla.
 *
 * Devuelve el prompt YA MONTADO además de las piezas sueltas: si n8n lo montara
 * por su cuenta, el botón "Probar" del dashboard estaría probando otra cosa.
 *
 * Con `?campaign_id=` coge el ICP, el canal y la EMPRESA de esa campaña; sin él,
 * el primer ICP, LinkedIn y la primera empresa.
 *
 * El playbook también se resuelve por empresa: si esa empresa tiene el suyo, ese;
 * si no, el global, que es el que trae el sistema de fábrica. Gracias a eso dar
 * de alta una empresa no obliga a escribir un método de venta desde cero.
 */
export async function GET(request: Request) {
  try {
    const campaignId = new URL(request.url).searchParams.get('campaign_id')

    const leadId = new URL(request.url).searchParams.get('lead_id')

    let icp = null
    let vendedora = null
    let canal: 'linkedin' | 'email' | 'instagram' = 'linkedin'

    if (campaignId) {
      const [fila] = await db
        .select({ campaign: campaigns, icp: icps, seller: workspaces })
        .from(campaigns)
        .leftJoin(icps, eq(campaigns.icpId, icps.id))
        .leftJoin(workspaces, eq(campaigns.workspaceId, workspaces.id))
        .where(eq(campaigns.id, campaignId))
      if (!fila) return jsonError('Esa campaña no existe.', 404)
      icp = fila.icp
      vendedora = fila.seller
      canal = fila.campaign.channel
    } else {
      ;[icp] = await db.select().from(icps).orderBy(asc(icps.createdAt)).limit(1)
      ;[vendedora] = await db.select().from(workspaces).orderBy(asc(workspaces.createdAt)).limit(1)
    }

    // Lo que sabemos de este prospecto en concreto, si se pide.
    let enriquecimiento = null
    if (leadId) {
      const [lead] = await db
        .select({ enrichment: leads.enrichment })
        .from(leads)
        .where(eq(leads.id, leadId))
      enriquecimiento = lead?.enrichment ?? null
    }

    const ajustes = await ajustesEfectivos(vendedora?.id)

    const playbook = await playbookActivo(vendedora?.id)
    if (!playbook) {
      return jsonError('No hay ningún playbook activo. Actívalo en /playbook.', 409)
    }

    return NextResponse.json({
      playbook,
      icp,
      vendedora,
      enriquecimiento,
      lecciones: ajustes.lessons,
      canal,
      modelo: ajustes.openrouterModel,
      autopilot: ajustes.autopilot,
      umbralParaAgendar: playbook.bookingRules.min_score_to_book,
      systemPrompt: construirSystemPrompt(playbook, icp, {
        empresa: ajustes.companyName,
        canal,
        vendedora,
        lecciones: ajustes.lessons,
        enriquecimiento,
      }),
    })
  } catch (err) {
    return serverError(err, 'No se pudo cargar el playbook activo')
  }
}
