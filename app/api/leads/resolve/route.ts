import { NextResponse } from 'next/server'
import { and, asc, desc, eq, ne, notInArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { TERMINAL_LEAD_STATUSES, campaigns, leads, touches } from '@/lib/db/schema'
import { jsonError, serverError } from '@/lib/api'

export const dynamic = 'force-dynamic'

/**
 * Encuentra a quién pertenece un mensaje entrante, y devuelve el hilo completo.
 *
 * Se resuelve primero por `unipile_chat_id`, que identifica una conversación
 * concreta y es inequívoco. El `provider_id` es el respaldo, y ahí sí puede
 * haber ambigüedad: la misma persona puede estar en dos campañas. En ese caso
 * gana el lead ACTIVO más recientemente tocado, porque es el hilo en el que esa
 * persona está de verdad contestando.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const chatId = url.searchParams.get('chat_id')
  const providerId = url.searchParams.get('provider_id')

  if (!chatId && !providerId) {
    return jsonError('Hace falta chat_id o provider_id.')
  }

  try {
    let lead: typeof leads.$inferSelect | undefined

    if (chatId) {
      const [porChat] = await db
        .select({ lead: leads })
        .from(touches)
        .innerJoin(leads, eq(touches.leadId, leads.id))
        .where(eq(touches.unipileChatId, chatId))
        .orderBy(desc(touches.createdAt))
        .limit(1)
      lead = porChat?.lead
    }

    if (!lead && providerId) {
      const candidatos = await db
        .select()
        .from(leads)
        .where(
          and(
            eq(leads.providerId, providerId),
            notInArray(leads.status, [...TERMINAL_LEAD_STATUSES]),
          ),
        )
        .orderBy(desc(leads.updatedAt))
        .limit(1)
      lead = candidatos[0]
    }

    if (!lead) {
      return NextResponse.json(
        {
          encontrado: false,
          // Un mensaje de alguien a quien no hemos escrito nosotros. No es un
          // error: puede ser tráfico normal de la cuenta.
          motivo: 'No hay ningún lead activo con ese chat_id ni provider_id.',
        },
        { status: 404 },
      )
    }

    const [campana] = await db.select().from(campaigns).where(eq(campaigns.id, lead.campaignId))
    const hilo = await db
      .select({
        direction: touches.direction,
        body: touches.body,
        status: touches.status,
        createdAt: touches.createdAt,
      })
      .from(touches)
      .where(and(eq(touches.leadId, lead.id), ne(touches.status, 'borrador')))
      .orderBy(asc(touches.createdAt))
      .limit(40)

    return NextResponse.json({
      encontrado: true,
      lead,
      campana,
      chatId: chatId ?? null,
      /** Congelado por un humano: el agente no debe responder. */
      congelado: lead.status === 'revision_humana',
      hilo: hilo.map((t) => ({
        quien: t.direction === 'out' ? 'nosotros' : 'prospecto',
        texto: t.body,
        cuando: t.createdAt,
      })),
    })
  } catch (err) {
    return serverError(err, 'No se pudo resolver el lead')
  }
}
