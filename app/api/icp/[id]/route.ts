import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { campaigns, icps } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'
import { cuerpoIcp } from '../route'

export const dynamic = 'force-dynamic'

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await parseBody(request, cuerpoIcp)
  if (!body.ok) return body.response
  try {
    const [actualizado] = await db.update(icps).set(body.data).where(eq(icps.id, id)).returning()
    if (!actualizado) return jsonError('Ese ICP no existe.', 404)
    return NextResponse.json(actualizado)
  } catch (err) {
    return serverError(err, 'No se pudo guardar el ICP')
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    // La clave ajena es RESTRICT, así que la base ya lo impediría; aquí se
    // explica cuáles son las campañas en vez de soltar un error de constraint.
    const enUso = await db
      .select({ name: campaigns.name })
      .from(campaigns)
      .where(eq(campaigns.icpId, id))
    if (enUso.length) {
      return jsonError(
        `Lo usan estas campañas: ${enUso.map((c) => c.name).join(', ')}. Cámbialas antes.`,
        409,
      )
    }
    await db.delete(icps).where(eq(icps.id, id))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return serverError(err, 'No se pudo borrar el ICP')
  }
}
