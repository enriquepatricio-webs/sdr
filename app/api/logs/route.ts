import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logLevelEnum, runLogs } from '@/lib/db/schema'
import { parseBody, serverError } from '@/lib/api'

export const dynamic = 'force-dynamic'

const cuerpo = z.object({
  workflow: z.string().min(1),
  leadId: z.string().uuid().nullable().optional(),
  level: z.enum(logLevelEnum.enumValues).default('info'),
  message: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
})

export async function GET(request: Request) {
  const leadId = new URL(request.url).searchParams.get('lead_id')
  try {
    const filas = await db
      .select()
      .from(runLogs)
      .where(leadId ? eq(runLogs.leadId, leadId) : undefined)
      .orderBy(desc(runLogs.createdAt))
      .limit(200)
    return NextResponse.json({ logs: filas })
  } catch (err) {
    return serverError(err, 'No se pudieron leer los registros')
  }
}

export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  try {
    const [creado] = await db
      .insert(runLogs)
      .values({ ...body.data, leadId: body.data.leadId ?? null })
      .returning({ id: runLogs.id })
    return NextResponse.json({ id: creado.id })
  } catch (err) {
    return serverError(err, 'No se pudo escribir el registro')
  }
}
