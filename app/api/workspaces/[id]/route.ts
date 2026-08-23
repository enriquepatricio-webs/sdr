import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { campaigns, workspaces } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'
import { cuerpoWorkspace } from '../route'

export const dynamic = 'force-dynamic'

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await parseBody(request, cuerpoWorkspace)
  if (!body.ok) return body.response
  try {
    const [actualizada] = await db.update(workspaces).set(body.data).where(eq(workspaces.id, id)).returning()
    if (!actualizada) return jsonError('Esa empresa no existe.', 404)
    return NextResponse.json(actualizada)
  } catch (err) {
    return serverError(err, 'No se pudo guardar la empresa')
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const enUso = await db
      .select({ name: campaigns.name })
      .from(campaigns)
      .where(eq(campaigns.workspaceId, id))
    if (enUso.length) {
      return jsonError(`La usan estas campañas: ${enUso.map((c) => c.name).join(', ')}.`, 409)
    }
    await db.delete(workspaces).where(eq(workspaces.id, id))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return serverError(err, 'No se pudo borrar la empresa')
  }
}
