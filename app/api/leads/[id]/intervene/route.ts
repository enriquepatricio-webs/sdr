import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { leads, runLogs } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'

export const dynamic = 'force-dynamic'

const cuerpo = z.object({
  /** true congela el lead, false lo devuelve al agente. */
  congelar: z.boolean(),
  /** Estado al que vuelve al descongelar. */
  volverA: z
    .enum(['nuevo', 'contactado', 'en_seguimiento', 'respondido', 'cualificando'])
    .default('respondido'),
})

/**
 * Congela un lead o lo devuelve al circuito.
 *
 * Congelar lo saca de /api/leads/next y hace que /api/leads/[id]/status rechace
 * cualquier cambio del agente. Es un freno de mano: mientras esté echado, este
 * prospecto no recibe nada automático.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response

  try {
    const [lead] = await db.select().from(leads).where(eq(leads.id, id))
    if (!lead) return jsonError('Ese lead no existe.', 404)

    const nuevo = body.data.congelar ? 'revision_humana' : body.data.volverA
    await db
      .update(leads)
      .set({
        status: nuevo,
        // Al congelar se borra la cita pendiente: si no, al descongelar el
        // agente se lanzaría de golpe con un seguimiento con semanas de retraso.
        nextActionAt: body.data.congelar ? null : new Date(),
      })
      .where(eq(leads.id, id))

    await db.insert(runLogs).values({
      workflow: 'dashboard',
      leadId: id,
      level: 'warn',
      message: body.data.congelar
        ? 'Intervención humana: el agente deja de tocar este lead'
        : `Devuelto al agente en estado "${nuevo}"`,
    })

    return NextResponse.json({ ok: true, status: nuevo })
  } catch (err) {
    return serverError(err, 'No se pudo intervenir sobre el lead')
  }
}
