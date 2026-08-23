import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { accounts, campaigns, leads, runLogs, touches } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'
import { UnipileError, enviarEnChat, iniciarChat, invitar } from '@/lib/unipile'
import { getSettings } from '@/lib/settings'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const cuerpo = z.object({
  leadId: z.string().uuid(),
  texto: z.string().min(1),
  step: z.number().int().positive().default(1),
  /** 'invitacion' = petición de contacto de LinkedIn; 'mensaje' = DM o email. */
  tipo: z.enum(['invitacion', 'mensaje']).default('mensaje'),
  /** Hilo existente. Si no viene, se abre uno nuevo. */
  chatId: z.string().optional(),
  /** Cuándo toca el siguiente toque, si procede. */
  nextActionAt: z.string().datetime().optional(),
  /** Estado al que pasa el lead después de enviar. */
  nuevoEstado: z
    .enum(['contactado', 'en_seguimiento', 'respondido', 'cualificando', 'cualificado'])
    .optional(),
})

/**
 * Enviar un mensaje. Es el único camino por el que sale texto hacia una persona.
 *
 * El orden es la restricción no negociable del sistema y está aquí, no en n8n:
 *
 *   1. Se REGISTRA el toque como borrador. Si esto falla, no se envía nada.
 *   2. Se envía por Unipile.
 *   3. Se CONFIRMA el toque con su id de mensaje y su fecha.
 *
 * Si el paso 2 falla, el toque queda en 'fallido' y NO se reintenta desde aquí:
 * el envío pudo salir y haber fallado solo la respuesta, y reintentar duplicaría
 * el mensaje al prospecto. Lo mira una persona.
 *
 * Con el autopiloto apagado se hace el paso 1 y se para: queda el borrador en el
 * hilo del lead, visible en el dashboard, y no sale nada.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  const d = body.data

  try {
    const [fila] = await db
      .select({ lead: leads, campana: campaigns, cuenta: accounts })
      .from(leads)
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .leftJoin(accounts, eq(campaigns.accountId, accounts.id))
      .where(eq(leads.id, d.leadId))

    if (!fila) return jsonError('Ese lead no existe.', 404)
    const { lead, campana, cuenta } = fila

    if (lead.status === 'revision_humana') {
      return jsonError('Ese lead está en revisión humana. El agente no puede escribirle.', 409)
    }
    if (!cuenta) return jsonError('La campaña no tiene cuenta de envío.', 409)
    if (cuenta.status !== 'active') {
      return jsonError(`La cuenta está en "${cuenta.status}".`, 409)
    }

    const ajustes = await getSettings()

    // ---- 1. Registrar ANTES de enviar --------------------------------------
    const [toque] = await db
      .insert(touches)
      .values({
        leadId: lead.id,
        accountId: cuenta.id,
        channel: campana.channel,
        direction: 'out',
        status: 'borrador',
        body: d.texto,
        unipileChatId: d.chatId,
        step: d.step,
      })
      .returning({ id: touches.id })

    // ---- Autopiloto apagado: aquí se para ----------------------------------
    if (!ajustes.autopilot) {
      await db.insert(runLogs).values({
        workflow: 'sdr-envio',
        leadId: lead.id,
        level: 'info',
        message: 'Borrador guardado. El autopiloto está apagado, no se ha enviado nada.',
      })
      return NextResponse.json({ enviado: false, motivo: 'autopiloto_apagado', touchId: toque.id })
    }

    // ---- 2. Enviar ----------------------------------------------------------
    try {
      let messageId: string
      let chatId = d.chatId ?? null

      if (d.tipo === 'invitacion') {
        if (!lead.providerId) {
          throw new UnipileError('El lead no tiene provider_id para invitarlo.', 400, '')
        }
        const r = await invitar({
          accountId: cuenta.unipileAccountId,
          providerId: lead.providerId,
          mensaje: d.texto,
          email: lead.email ?? undefined,
        })
        messageId = r.invitation_id
      } else if (chatId) {
        const r = await enviarEnChat(chatId, d.texto)
        messageId = r.message_id
      } else {
        if (!lead.providerId) {
          throw new UnipileError('El lead no tiene provider_id para abrir conversación.', 400, '')
        }
        const r = await iniciarChat({
          accountId: cuenta.unipileAccountId,
          attendeeId: lead.providerId,
          texto: d.texto,
        })
        messageId = r.message_id
        chatId = r.chat_id
      }

      // ---- 3. Confirmar -----------------------------------------------------
      const ahora = new Date()
      await db
        .update(touches)
        .set({
          status: 'enviado',
          sentAt: ahora,
          unipileMessageId: messageId,
          unipileChatId: chatId,
        })
        .where(eq(touches.id, toque.id))

      await db
        .update(leads)
        .set({
          status: d.nuevoEstado ?? (lead.status === 'nuevo' ? 'contactado' : lead.status),
          touchCount: lead.touchCount + 1,
          nextActionAt: d.nextActionAt ? new Date(d.nextActionAt) : lead.nextActionAt,
        })
        .where(eq(leads.id, lead.id))

      return NextResponse.json({ enviado: true, touchId: toque.id, messageId, chatId })
    } catch (err) {
      // El toque se queda en 'fallido'. Nadie lo reintenta automáticamente.
      await db.update(touches).set({ status: 'fallido' }).where(eq(touches.id, toque.id))
      await db.insert(runLogs).values({
        workflow: 'sdr-envio',
        leadId: lead.id,
        level: 'error',
        message: `Falló el envío: ${err instanceof Error ? err.message : String(err)}`,
        payload: { touchId: toque.id, noSeReintenta: true },
      })
      return jsonError(
        `El envío falló y NO se va a reintentar (podría duplicar el mensaje). Revísalo a mano. Detalle: ${err instanceof Error ? err.message : String(err)}`,
        502,
        { touchId: toque.id },
      )
    }
  } catch (err) {
    return serverError(err, 'No se pudo enviar el mensaje')
  }
}
