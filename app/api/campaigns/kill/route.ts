import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { campaigns, runLogs } from '@/lib/db/schema'
import { serverError } from '@/lib/api'
import { setSetting } from '@/lib/settings'

export const dynamic = 'force-dynamic'

/**
 * Parada de emergencia.
 *
 * Pausa todas las campañas y apaga el autopiloto. No hace falta nada más:
 * /api/leads/next solo mira campañas en 'running', así que en cuanto esto
 * termina la cola de envío está vacía y n8n no tiene de dónde sacar trabajo.
 *
 * Es de ida solamente. Reanudar se hace campaña a campaña, a mano y a
 * conciencia: quien pulsa esto está apagando un fuego, no haciendo una pausa.
 */
export async function POST() {
  try {
    const pausadas = await db
      .update(campaigns)
      .set({ status: 'paused' })
      .where(eq(campaigns.status, 'running'))
      .returning({ id: campaigns.id, name: campaigns.name })

    await setSetting('autopilot', false)

    await db.insert(runLogs).values({
      workflow: 'dashboard',
      level: 'warn',
      message: `Parada de emergencia: ${pausadas.length} campañas pausadas y autopiloto apagado`,
      payload: { campanas: pausadas.map((c) => c.name) },
    })

    return NextResponse.json({ pausadas: pausadas.length, campanas: pausadas })
  } catch (err) {
    return serverError(err, 'No se pudo ejecutar la parada')
  }
}
