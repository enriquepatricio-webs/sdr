import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { accounts, leadMagnets, runLogs } from '@/lib/db/schema'
import { serverError } from '@/lib/api'
import { ejecutarCiclo } from '@/lib/magnets'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Una vuelta a TODOS los imanes encendidos. Es lo que llama n8n cada cuarto de
 * hora; el ciclo de uno solo (`/api/magnets/[id]/run`) es para probar a mano.
 *
 * Un imán que falla no puede llevarse por delante a los demás: cada uno va en su
 * propio try. Si Apify se cae leyendo los comentarios de un post, el resto sigue
 * entregando recursos a quien ya los tenía pedidos.
 *
 * El ritmo real no lo marca este cron sino el tope horario de cada cuenta de
 * Instagram (8/hora por defecto). Llamarlo más a menudo no envía más.
 */
export async function POST() {
  try {
    const filas = await db
      .select({ iman: leadMagnets, cuenta: accounts })
      .from(leadMagnets)
      .innerJoin(accounts, eq(leadMagnets.accountId, accounts.id))
      .where(and(eq(leadMagnets.active, true), eq(accounts.status, 'active')))

    const resultados: { iman: string; resumen?: unknown; error?: string }[] = []

    for (const { iman, cuenta } of filas) {
      try {
        resultados.push({ iman: iman.name, resumen: await ejecutarCiclo(iman, cuenta) })
      } catch (err) {
        const detalle = err instanceof Error ? err.message : String(err)
        resultados.push({ iman: iman.name, error: detalle })
        await db.insert(runLogs).values({
          workflow: 'iman',
          level: 'error',
          message: `El imán "${iman.name}" falló: ${detalle}`,
          payload: { magnetId: iman.id },
        })
      }
    }

    return NextResponse.json({ imanes: filas.length, resultados })
  } catch (err) {
    return serverError(err, 'No se pudieron ejecutar los imanes')
  }
}
