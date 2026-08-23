import { NextResponse } from 'next/server'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { leads, touches } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'

export const dynamic = 'force-dynamic'

const cuerpo = z.object({
  status: z.enum(['enviado', 'fallido']),
  unipileMessageId: z.string().optional(),
  unipileChatId: z.string().optional(),
  sentAt: z.string().datetime().optional(),
  /** Cuándo toca el siguiente toque. Lo calcula n8n con followup_delays. */
  nextActionAt: z.string().datetime().optional(),
})

/**
 * Confirma qué pasó con un mensaje ya registrado.
 *
 * Un toque 'fallido' se queda como está y NO se reintenta desde aquí: puede
 * haber salido y haber fallado solo la confirmación, y reintentar duplicaría el
 * mensaje al prospecto. Lo resuelve un humano mirando el hilo.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  const d = body.data

  if (d.status === 'enviado' && !d.sentAt) {
    return jsonError('Confirmar un envío necesita sentAt.')
  }

  try {
    const [toque] = await db.select().from(touches).where(eq(touches.id, id))
    if (!toque) return jsonError('Ese mensaje no existe.', 404)

    if (toque.status === 'enviado') {
      return NextResponse.json({ ok: true, yaConfirmado: true, leadId: toque.leadId })
    }

    await db
      .update(touches)
      .set({
        status: d.status,
        sentAt: d.sentAt ? new Date(d.sentAt) : null,
        unipileMessageId: d.unipileMessageId ?? toque.unipileMessageId,
        unipileChatId: d.unipileChatId ?? toque.unipileChatId,
      })
      .where(eq(touches.id, id))

    if (d.status === 'enviado' && toque.direction === 'out') {
      await db
        .update(leads)
        .set({
          touchCount: sql`${leads.touchCount} + 1`,
          nextActionAt: d.nextActionAt ? new Date(d.nextActionAt) : undefined,
        })
        .where(eq(leads.id, toque.leadId))
    }

    return NextResponse.json({ ok: true, leadId: toque.leadId })
  } catch (err) {
    return serverError(err, 'No se pudo confirmar el mensaje')
  }
}
