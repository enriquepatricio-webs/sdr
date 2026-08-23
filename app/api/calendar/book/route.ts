import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { campaigns, leads, meetings, playbooks, runLogs } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'
import { agendarReunion } from '@/lib/composio'
import { avisar, formatearAvisoReunion } from '@/lib/telegram'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const cuerpo = z.object({
  leadId: z.string().uuid(),
  inicio: z.string().datetime(),
  fin: z.string().datetime().optional(),
})

/**
 * Agenda la reunión. Es el único camino, y comprueba el umbral por su cuenta.
 *
 * La regla dura dice que el agente no puede agendar sin haber cualificado por
 * encima del umbral. Confiar en que el prompt la respete no basta: se comprueba
 * aquí contra el score guardado, así que aunque el modelo se salte la
 * instrucción, la reunión no se crea.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  const d = body.data

  try {
    const [playbook] = await db.select().from(playbooks).where(eq(playbooks.isActive, true))
    if (!playbook) return jsonError('No hay playbook activo.', 409)

    const [fila] = await db
      .select({ lead: leads, campana: campaigns })
      .from(leads)
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(eq(leads.id, d.leadId))
    if (!fila) return jsonError('Ese lead no existe.', 404)
    const { lead } = fila

    const umbral = playbook.bookingRules.min_score_to_book
    if (lead.score === null) {
      return jsonError(
        `Este lead no está cualificado. Llama antes a registrar_cualificacion.`,
        409,
        { umbral },
      )
    }
    if (lead.score < umbral) {
      return jsonError(
        `Score ${lead.score}, por debajo del umbral ${umbral}. No se puede agendar con este lead.`,
        409,
        { score: lead.score, umbral },
      )
    }

    const inicio = new Date(d.inicio)
    const fin = d.fin
      ? new Date(d.fin)
      : new Date(inicio.getTime() + playbook.bookingRules.duration_min * 60_000)

    const evento = await agendarReunion({
      inicio,
      fin,
      resumen: `${lead.fullName}${lead.company ? ` · ${lead.company}` : ''}`,
      descripcion: lead.qualification?.reasoning ?? undefined,
      emailInvitado: lead.email ?? undefined,
      timezone: playbook.bookingRules.timezone,
    })

    const [reunion] = await db
      .insert(meetings)
      .values({
        leadId: lead.id,
        composioEventId: evento.id,
        startAt: inicio,
        endAt: fin,
        meetUrl: evento.meetUrl ?? evento.htmlLink,
        status: 'booked',
      })
      .onConflictDoNothing()
      .returning()

    await db
      .update(leads)
      .set({ status: 'agendado', nextActionAt: null })
      .where(eq(leads.id, lead.id))

    await db.insert(runLogs).values({
      workflow: 'sdr-inbound',
      leadId: lead.id,
      level: 'info',
      message: `Reunión agendada: ${inicio.toISOString()}`,
      payload: { eventId: evento.id },
    })

    // El aviso no puede tumbar el agendado: si Telegram falla, la reunión existe.
    const aviso = await avisar(
      formatearAvisoReunion({
        nombre: lead.fullName,
        cargo: lead.headline,
        empresa: lead.company,
        inicio,
        timezone: playbook.bookingRules.timezone,
        score: lead.score,
        porQue: lead.qualification?.summary ?? lead.qualification?.reasoning ?? '',
        leadId: lead.id,
      }),
    ).catch(() => ({ ok: false as const, error: 'Telegram falló' }))

    return NextResponse.json({
      reunion,
      meetUrl: evento.meetUrl ?? evento.htmlLink,
      avisoEnviado: aviso.ok,
    })
  } catch (err) {
    return serverError(err, 'No se pudo agendar la reunión')
  }
}
