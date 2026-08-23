import { NextResponse } from 'next/server'
import { asc } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { sellers } from '@/lib/db/schema'
import { parseBody, serverError } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const cuerpoEmpresa = z.object({
  name: z.string().min(1),
  website: z.string().nullable().optional(),
  context: z.string().nullable().optional(),
  offer: z.string().nullable().optional(),
})

export async function GET() {
  try {
    return NextResponse.json({ empresas: await db.select().from(sellers).orderBy(asc(sellers.name)) })
  } catch (err) {
    return serverError(err, 'No se pudieron leer las empresas')
  }
}

export async function POST(request: Request) {
  const body = await parseBody(request, cuerpoEmpresa)
  if (!body.ok) return body.response
  try {
    const [creada] = await db.insert(sellers).values(body.data).returning()
    return NextResponse.json(creada)
  } catch (err) {
    return serverError(err, 'No se pudo crear la empresa')
  }
}
