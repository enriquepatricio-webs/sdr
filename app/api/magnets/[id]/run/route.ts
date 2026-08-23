import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { accounts, leadMagnets } from '@/lib/db/schema'
import { jsonError, serverError } from '@/lib/api'
import { ejecutarCiclo } from '@/lib/magnets'

export const dynamic = 'force-dynamic'
// Lee comentarios y puede refrescar la lista de seguidores: los dos son
// ejecuciones de Apify que se esperan aquí dentro.
export const maxDuration = 300

/** Un ciclo de UN imán, a mano desde el dashboard. El ciclo vive en lib/magnets.ts. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const [fila] = await db
      .select({ iman: leadMagnets, cuenta: accounts })
      .from(leadMagnets)
      .innerJoin(accounts, eq(leadMagnets.accountId, accounts.id))
      .where(eq(leadMagnets.id, id))

    if (!fila) return jsonError('Ese imán no existe.', 404)
    if (!fila.iman.active) return jsonError('Ese imán está apagado.', 409)
    if (fila.cuenta.status !== 'active') {
      return jsonError(`La cuenta está en "${fila.cuenta.status}".`, 409)
    }

    return NextResponse.json(await ejecutarCiclo(fila.iman, fila.cuenta))
  } catch (err) {
    return serverError(err, 'No se pudo ejecutar el imán')
  }
}
