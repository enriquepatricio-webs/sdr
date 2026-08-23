import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { leads, runLogs } from '@/lib/db/schema'
import { parseBody, serverError } from '@/lib/api'
import { avisar, formatearAvisoEscalado } from '@/lib/telegram'

export const dynamic = 'force-dynamic'

const cuerpo = z.object({
  tipo: z.enum(['escalado', 'libre']).default('libre'),
  texto: z.string().optional(),
  leadId: z.string().uuid().optional(),
  motivo: z.string().optional(),
  ultimoMensaje: z.string().optional(),
})

/** Avisos a Telegram. Lo usa la tool `escalar_humano` del agente. */
export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  const d = body.data

  try {
    let texto = d.texto ?? ''

    if (d.tipo === 'escalado' && d.leadId) {
      const [lead] = await db.select().from(leads).where(eq(leads.id, d.leadId))
      if (lead) {
        // Congelar y avisar van juntos: avisar sin congelar deja al agente
        // escribiendo mientras el humano lee el aviso.
        await db
          .update(leads)
          .set({ status: 'revision_humana', nextActionAt: null })
          .where(eq(leads.id, d.leadId))

        texto = formatearAvisoEscalado({
          nombre: lead.fullName,
          motivo: d.motivo ?? 'sin motivo indicado',
          ultimoMensaje: d.ultimoMensaje ?? '',
          leadId: lead.id,
        })

        await db.insert(runLogs).values({
          workflow: 'sdr-inbound',
          leadId: lead.id,
          level: 'warn',
          message: `Escalado a humano: ${d.motivo ?? 'sin motivo'}`,
        })
      }
    }

    const resultado = await avisar(texto)
    return NextResponse.json(resultado, { status: resultado.ok ? 200 : 502 })
  } catch (err) {
    return serverError(err, 'No se pudo enviar el aviso')
  }
}
