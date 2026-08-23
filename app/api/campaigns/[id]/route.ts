import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { MAX_DAILY_LIMIT, campaigns } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'
import { traducir } from '../route'

export const dynamic = 'force-dynamic'

const cuerpo = z.object({
  name: z.string().min(1),
  channel: z.enum(['linkedin', 'email', 'instagram']),
  accountId: z.string().uuid().nullable(),
  playbookId: z.string().uuid().nullable(),
  icpId: z.string().uuid().nullable(),
  workspaceId: z.string().uuid().nullable().optional(),
  dailyCap: z.number().int().min(1).max(MAX_DAILY_LIMIT),
  maxTouches: z.number().int().min(1).max(10),
  followupDelays: z.array(z.number().int().min(1).max(90)).min(1),
  sendingWindow: z.object({
    tz: z.string().min(1),
    from: z.string().regex(/^\d{2}:\d{2}$/),
    to: z.string().regex(/^\d{2}:\d{2}$/),
    days: z.array(z.number().int().min(1).max(7)),
  }),
})

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  const d = body.data

  if (d.sendingWindow.from >= d.sendingWindow.to) {
    return jsonError('La ventana tiene que abrir antes de cerrar.')
  }

  try {
    const [actualizada] = await db.update(campaigns).set(d).where(eq(campaigns.id, id)).returning()
    if (!actualizada) return jsonError('Esa campaña no existe.', 404)
    return NextResponse.json(actualizada)
  } catch (err) {
    // Los errores típicos aquí son las claves ajenas compuestas: canal que no
    // cuadra con el proveedor de la cuenta, o cuenta de otra empresa.
    const traducido = traducir(err, d.channel)
    if (traducido !== 'No se pudo crear la campaña') return jsonError(traducido, 409)
    return serverError(err, 'No se pudo guardar la campaña')
  }
}
