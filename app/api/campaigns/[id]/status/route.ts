import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { accounts, campaigns, runLogs } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'

export const dynamic = 'force-dynamic'

const cuerpo = z.object({ status: z.enum(['draft', 'running', 'paused', 'done']) })

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response

  try {
    const [fila] = await db
      .select({ campana: campaigns, cuenta: accounts })
      .from(campaigns)
      .leftJoin(accounts, eq(campaigns.accountId, accounts.id))
      .where(eq(campaigns.id, id))
    if (!fila) return jsonError('Esa campaña no existe.', 404)

    // La base rechazaría un 'running' sin cuenta ni playbook, pero un 500 de
    // constraint no le dice a nadie qué falta. Aquí sí.
    if (body.data.status === 'running') {
      const falta: string[] = []
      if (!fila.campana.accountId) falta.push('una cuenta de envío')
      if (!fila.campana.playbookId) falta.push('un playbook')
      if (!fila.campana.icpId) falta.push('un ICP')
      if (falta.length) {
        return jsonError(`No se puede arrancar sin ${falta.join(', ')}.`, 409)
      }
      if (fila.cuenta && fila.cuenta.status !== 'active') {
        return jsonError(
          `La cuenta "${fila.cuenta.displayName}" está en "${fila.cuenta.status}". Actívala antes.`,
          409,
        )
      }
    }

    await db.update(campaigns).set({ status: body.data.status }).where(eq(campaigns.id, id))

    await db.insert(runLogs).values({
      workflow: 'dashboard',
      level: 'info',
      message: `Campaña "${fila.campana.name}": ${fila.campana.status} → ${body.data.status}`,
    })

    return NextResponse.json({ ok: true, status: body.data.status })
  } catch (err) {
    return serverError(err, 'No se pudo cambiar el estado de la campaña')
  }
}
