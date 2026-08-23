import { NextResponse } from 'next/server'
import { asc } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { icps } from '@/lib/db/schema'
import { parseBody, serverError } from '@/lib/api'

export const dynamic = 'force-dynamic'

const senal = z.object({ id: z.string().min(1), signal: z.string().min(1), source: z.string().optional() })

export const cuerpoIcp = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  criteria: z.array(senal).default([]),
  disqualifiers: z.array(senal).default([]),
})

export async function GET() {
  try {
    return NextResponse.json({ icps: await db.select().from(icps).orderBy(asc(icps.createdAt)) })
  } catch (err) {
    return serverError(err, 'No se pudieron leer los ICP')
  }
}

export async function POST(request: Request) {
  const body = await parseBody(request, cuerpoIcp)
  if (!body.ok) return body.response
  try {
    const [creado] = await db.insert(icps).values(body.data).returning()
    return NextResponse.json(creado)
  } catch (err) {
    return serverError(err, 'No se pudo crear el ICP')
  }
}
