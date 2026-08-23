import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { playbooks } from '@/lib/db/schema'
import { jsonError, serverError } from '@/lib/api'
import { activarPlaybook } from '@/lib/playbook'

export const dynamic = 'force-dynamic'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const [existe] = await db
      .select({ id: playbooks.id, version: playbooks.version })
      .from(playbooks)
      .where(eq(playbooks.id, id))
    if (!existe) return jsonError('Esa versión de playbook no existe.', 404)

    await activarPlaybook(id)
    return NextResponse.json({ ok: true, version: existe.version })
  } catch (err) {
    return serverError(err, 'No se pudo activar la versión')
  }
}
