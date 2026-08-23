import { NextResponse } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { campaigns, icps, playbooks } from '@/lib/db/schema'
import { jsonError, serverError } from '@/lib/api'
import { construirSystemPrompt } from '@/lib/agent-prompt'
import { getSettings } from '@/lib/settings'

export const dynamic = 'force-dynamic'

/**
 * Lo que n8n carga en cada ejecución del agente.
 *
 * Devuelve el prompt YA MONTADO además de las piezas sueltas: si n8n lo montara
 * por su cuenta, el botón "Probar" del dashboard estaría probando otra cosa.
 *
 * Con `?campaign_id=` coge el ICP y el canal de esa campaña; sin él, el primer
 * ICP y LinkedIn.
 */
export async function GET(request: Request) {
  try {
    const campaignId = new URL(request.url).searchParams.get('campaign_id')

    const [playbook] = await db.select().from(playbooks).where(eq(playbooks.isActive, true))
    if (!playbook) {
      return jsonError('No hay ningún playbook activo. Actívalo en /playbook.', 409)
    }

    let icp = null
    let canal: 'linkedin' | 'email' | 'instagram' = 'linkedin'

    if (campaignId) {
      const [fila] = await db
        .select({ campaign: campaigns, icp: icps })
        .from(campaigns)
        .leftJoin(icps, eq(campaigns.icpId, icps.id))
        .where(eq(campaigns.id, campaignId))
      if (!fila) return jsonError('Esa campaña no existe.', 404)
      icp = fila.icp
      canal = fila.campaign.channel
    } else {
      ;[icp] = await db.select().from(icps).orderBy(asc(icps.createdAt)).limit(1)
    }

    const ajustes = await getSettings()

    return NextResponse.json({
      playbook,
      icp,
      canal,
      modelo: ajustes.openrouterModel,
      autopilot: ajustes.autopilot,
      umbralParaAgendar: playbook.bookingRules.min_score_to_book,
      systemPrompt: construirSystemPrompt(playbook, icp, {
        empresa: ajustes.companyName,
        canal,
      }),
    })
  } catch (err) {
    return serverError(err, 'No se pudo cargar el playbook activo')
  }
}
