import { NextResponse } from 'next/server'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { leads, touches } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'

export const dynamic = 'force-dynamic'

const cuerpo = z.object({
  leadId: z.string().uuid(),
  accountId: z.string().uuid().optional(),
  channel: z.enum(['linkedin', 'email', 'instagram']),
  direction: z.enum(['out', 'in']),
  body: z.string(),
  step: z.number().int().positive().default(1),
  /** Por defecto borrador: nada se da por enviado sin decirlo. */
  status: z.enum(['borrador', 'enviado', 'fallido']).default('borrador'),
  unipileMessageId: z.string().optional(),
  unipileChatId: z.string().optional(),
  sentAt: z.string().datetime().optional(),
})

/**
 * Registra un mensaje.
 *
 * Dos usos y los dos importan:
 *
 * SALIENTE — se llama ANTES de enviar, con status 'borrador'. Si esta llamada
 * falla, n8n no debe enviar nada: el spec prohíbe reintentar el envío porque el
 * prospecto podría recibir el mensaje dos veces. Después del envío se confirma
 * con PATCH /api/touches/[id].
 *
 * ENTRANTE — el webhook de Unipile puede llegar duplicado. Si el
 * unipile_message_id ya existe, se devuelve `duplicado: true` y un 200. n8n debe
 * cortar ahí y NO invocar al agente: si no, el prospecto recibe dos respuestas
 * al mismo mensaje.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  const d = body.data

  if (d.status === 'enviado' && !d.sentAt) {
    return jsonError('Un toque "enviado" necesita sentAt: el tope diario se cuenta con esa fecha.')
  }
  if (d.direction === 'in' && d.status !== 'enviado') {
    return jsonError('Un mensaje entrante ya ha ocurrido: su status tiene que ser "enviado".')
  }

  try {
    if (d.unipileMessageId) {
      const [existente] = await db
        .select({ id: touches.id, leadId: touches.leadId })
        .from(touches)
        .where(eq(touches.unipileMessageId, d.unipileMessageId))

      if (existente) {
        return NextResponse.json({ id: existente.id, leadId: existente.leadId, duplicado: true })
      }
    }

    const [creado] = await db
      .insert(touches)
      .values({
        leadId: d.leadId,
        accountId: d.accountId,
        channel: d.channel,
        direction: d.direction,
        body: d.body,
        step: d.step,
        status: d.status,
        unipileMessageId: d.unipileMessageId,
        unipileChatId: d.unipileChatId,
        sentAt: d.sentAt ? new Date(d.sentAt) : null,
      })
      // Carrera entre dos webhooks simultáneos: el índice único decide y aquí
      // simplemente no se inserta el segundo.
      .onConflictDoNothing()
      .returning({ id: touches.id })

    if (!creado) {
      const [existente] = await db
        .select({ id: touches.id, leadId: touches.leadId })
        .from(touches)
        .where(eq(touches.unipileMessageId, d.unipileMessageId!))
      return NextResponse.json({ id: existente?.id, leadId: existente?.leadId, duplicado: true })
    }

    // El contador solo avanza con lo que salió de verdad.
    if (d.direction === 'out' && d.status === 'enviado') {
      await db
        .update(leads)
        .set({ touchCount: sql`${leads.touchCount} + 1` })
        .where(eq(leads.id, d.leadId))
    }

    return NextResponse.json({ id: creado.id, duplicado: false })
  } catch (err) {
    return serverError(err, 'No se pudo registrar el mensaje')
  }
}
