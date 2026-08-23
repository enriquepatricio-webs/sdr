import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { MAX_DAILY_LIMIT, MAX_HOURLY_LIMIT, accounts, runLogs } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'

export const dynamic = 'force-dynamic'

const cuerpo = z.object({
  displayName: z.string().min(1).optional(),
  dailyLimit: z.number().int().min(1).max(MAX_DAILY_LIMIT).optional(),
  hourlyLimit: z.number().int().min(1).max(MAX_HOURLY_LIMIT).nullable().optional(),
  status: z.enum(['active', 'paused', 'disconnected']).optional(),
})

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response

  try {
    const [antes] = await db.select().from(accounts).where(eq(accounts.id, id))
    if (!antes) return jsonError('Esa cuenta no existe.', 404)

    const hourly = body.data.hourlyLimit ?? antes.hourlyLimit
    const daily = body.data.dailyLimit ?? antes.dailyLimit
    if (hourly !== null && hourly > daily) {
      return jsonError('El tope por hora no puede superar al diario.')
    }

    const [actualizada] = await db
      .update(accounts)
      .set(body.data)
      .where(eq(accounts.id, id))
      .returning()

    if (body.data.status && body.data.status !== antes.status) {
      await db.insert(runLogs).values({
        workflow: 'dashboard',
        level: 'info',
        message: `Cuenta "${antes.displayName}": ${antes.status} → ${body.data.status}`,
      })
    }

    return NextResponse.json(actualizada)
  } catch (err) {
    return serverError(err, 'No se pudo guardar la cuenta')
  }
}
