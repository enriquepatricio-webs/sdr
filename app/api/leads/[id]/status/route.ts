import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { leadStatusEnum, leads, runLogs } from '@/lib/db/schema'
import { fechaIso,jsonError, parseBody, serverError } from '@/lib/api'

export const dynamic = 'force-dynamic'

const cuerpo = z.object({
  status: z.enum(leadStatusEnum.enumValues),
  score: z.number().int().min(0).max(100).nullable().optional(),
  qualification: z
    .object({
      score: z.number().int().min(0).max(100),
      verdict: z.enum(['cualificado', 'descartado', 'pendiente']),
      reasoning: z.string(),
      summary: z.string().optional(),
      answers: z
        .array(z.object({ criterion_id: z.string(), answer: z.string(), met: z.boolean() }))
        .optional(),
      disqualified_by: z.string().optional(),
    })
    .optional(),
  nextActionAt: fechaIso().nullable().optional(),
  /** Motivo del cambio. Se guarda en run_logs para poder auditarlo después. */
  motivo: z.string().optional(),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  const d = body.data

  try {
    const [lead] = await db.select().from(leads).where(eq(leads.id, id))
    if (!lead) return jsonError('Ese lead no existe.', 404)

    // Un lead congelado por un humano no vuelve solo al circuito del agente.
    if (lead.status === 'revision_humana' && d.status !== 'revision_humana') {
      return jsonError(
        'Este lead está en revisión humana. El agente no puede sacarlo de ahí; hazlo desde el dashboard.',
        409,
      )
    }

    const [actualizado] = await db
      .update(leads)
      .set({
        status: d.status,
        score: d.score ?? d.qualification?.score ?? lead.score,
        qualification: d.qualification
          ? { ...d.qualification, evaluated_at: new Date().toISOString() }
          : lead.qualification,
        nextActionAt:
          d.nextActionAt === undefined
            ? lead.nextActionAt
            : d.nextActionAt === null
              ? null
              : new Date(d.nextActionAt),
      })
      .where(eq(leads.id, id))
      .returning()

    await db.insert(runLogs).values({
      workflow: 'api',
      leadId: id,
      level: 'info',
      message: `Estado: ${lead.status} → ${d.status}${d.motivo ? ` (${d.motivo})` : ''}`,
      payload: { anterior: lead.status, nuevo: d.status, score: actualizado.score },
    })

    return NextResponse.json({ ok: true, lead: actualizado })
  } catch (err) {
    return serverError(err, 'No se pudo actualizar el lead')
  }
}
