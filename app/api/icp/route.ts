import { NextResponse } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { icps } from '@/lib/db/schema'
import { parseBody, serverError } from '@/lib/api'
import { obtenerWorkspace } from '@/lib/workspace'

export const dynamic = 'force-dynamic'

const senal = z.object({ id: z.string().min(1), signal: z.string().min(1), source: z.string().optional() })

export const cuerpoIcp = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  criteria: z.array(senal).default([]),
  disqualifiers: z.array(senal).default([]),
  /** A quién le vende esta empresa. Sin esto, dos clientes comparten perfil. */
  workspaceId: z.string().uuid().optional(),
})

export async function GET(request: Request) {
  try {
    const empresa = await obtenerWorkspace(new URL(request.url).searchParams.get('workspaceId'))
    return NextResponse.json({
      icps: await db
        .select()
        .from(icps)
        .where(empresa ? eq(icps.workspaceId, empresa.id) : undefined)
        .orderBy(asc(icps.createdAt)),
    })
  } catch (err) {
    return serverError(err, 'No se pudieron leer los ICP')
  }
}

export async function POST(request: Request) {
  const body = await parseBody(request, cuerpoIcp)
  if (!body.ok) return body.response
  try {
    const empresa = await obtenerWorkspace(body.data.workspaceId)
    const [creado] = await db
      .insert(icps)
      .values({ ...body.data, workspaceId: empresa?.id ?? null })
      .returning()
    return NextResponse.json(creado)
  } catch (err) {
    return serverError(err, 'No se pudo crear el ICP')
  }
}
