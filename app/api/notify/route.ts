import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { leads, runLogs } from '@/lib/db/schema'
import { parseBody, serverError } from '@/lib/api'

export const dynamic = 'force-dynamic'

const cuerpo = z.object({
  tipo: z.enum(['escalado', 'libre']).default('libre'),
  texto: z.string().optional(),
  leadId: z.string().uuid().optional(),
  motivo: z.string().optional(),
  ultimoMensaje: z.string().optional(),
})

/**
 * Pasar una conversación a una persona. Lo usa la tool `escalar_humano` del agente.
 *
 * Antes además avisaba por Telegram. Ya no: el usuario quitó los avisos. Lo que
 * queda es lo importante, que es CONGELAR el lead — sin eso el agente seguiría
 * contestando a alguien enfadado o con una petición legal. El escalado se ve en
 * el panel por su estado, 'revision_humana', y en el registro.
 *
 * El cuerpo sigue aceptando lo de antes porque el flujo de n8n lo manda así.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  const d = body.data

  try {
    if (d.tipo === 'escalado' && d.leadId) {
      const [lead] = await db.select({ id: leads.id }).from(leads).where(eq(leads.id, d.leadId))
      if (lead) {
        await db
          .update(leads)
          .set({ status: 'revision_humana', nextActionAt: null })
          .where(eq(leads.id, d.leadId))

        await db.insert(runLogs).values({
          workflow: 'sdr-inbound',
          leadId: lead.id,
          level: 'warn',
          message: `Escalado a humano: ${d.motivo ?? 'sin motivo'}`,
          payload: { ultimoMensaje: d.ultimoMensaje?.slice(0, 500) ?? null },
        })
      }
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return serverError(err, 'No se pudo escalar')
  }
}
