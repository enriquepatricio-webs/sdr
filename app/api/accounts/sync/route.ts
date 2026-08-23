import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { DEFAULT_DAILY_LIMIT, DEFAULT_HOURLY_LIMIT, accounts, runLogs } from '@/lib/db/schema'
import { serverError } from '@/lib/api'
import { canalDeProveedor, listarCuentas } from '@/lib/unipile'
import { obtenerWorkspace } from '@/lib/workspace'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Trae de Unipile las cuentas conectadas y las refleja aquí.
 *
 * Las cuentas nuevas entran SIEMPRE en pausa, aunque en Unipile estén
 * perfectas. Conectar una cuenta y que empiece a escribir a desconocidos en el
 * mismo gesto es justo lo que no queremos: activarla es una decisión aparte.
 *
 * Y los topes de una cuenta que ya existe no se tocan: si alguien los bajó a
 * mano, una sincronización no puede volver a subirlos.
 */
export async function POST(request: Request) {
  try {
    // Cada cuenta pertenece a una empresa. Sin ella la clave ajena compuesta de
    // las campañas la rechaza, así que una cuenta sin empresa es una cuenta
    // inservible: se le asigna al entrar, no después.
    const empresa = await obtenerWorkspace(
      new URL(request.url).searchParams.get('workspaceId'),
    )

    const remotas = await listarCuentas()
    const locales = await db.select().from(accounts)
    const porId = new Map(locales.map((a) => [a.unipileAccountId, a]))

    const nuevas: string[] = []
    const actualizadas: string[] = []
    const ignoradas: string[] = []

    for (const r of remotas) {
      const canal = canalDeProveedor(r.type)
      if (!canal) {
        ignoradas.push(`${r.name} (${r.type})`)
        continue
      }

      const sanaEnUnipile = (r.sources ?? []).every((s) => s.status === 'OK')
      const existente = porId.get(r.id)

      if (!existente) {
        await db
          .insert(accounts)
          .values({
            unipileAccountId: r.id,
            workspaceId: empresa?.id ?? null,
            provider: canal,
            displayName: r.name || `${canal} ${r.id.slice(0, 6)}`,
            dailyLimit: DEFAULT_DAILY_LIMIT,
            hourlyLimit: DEFAULT_HOURLY_LIMIT[canal] ?? null,
            // Una cuenta que Unipile ya ve rota no entra como "en pausa": entra
            // como desconectada. Si no, la activas, falla el primer envío y no
            // hay forma de saber por qué.
            status: sanaEnUnipile ? 'paused' : 'disconnected',
          })
          // Dos clics seguidos en Sincronizar daban un 500 por clave duplicada.
          .onConflictDoNothing({ target: accounts.unipileAccountId })
        nuevas.push(r.name || r.id)
        continue
      }

      // Si Unipile dice que la cuenta está rota, aquí también. Al revés no:
      // que Unipile la vea bien no reactiva algo que se pausó a propósito.
      if (!sanaEnUnipile && existente.status === 'active') {
        await db
          .update(accounts)
          .set({ status: 'disconnected' })
          .where(eq(accounts.id, existente.id))
        actualizadas.push(`${existente.displayName} → desconectada`)
      }
    }

    await db.insert(runLogs).values({
      workflow: 'dashboard',
      level: 'info',
      message: `Sincronización con Unipile: ${nuevas.length} nuevas, ${actualizadas.length} actualizadas`,
      payload: { nuevas, actualizadas, ignoradas },
    })

    return NextResponse.json({
      encontradas: remotas.length,
      nuevas,
      actualizadas,
      ignoradas,
    })
  } catch (err) {
    return serverError(err, 'No se pudo sincronizar con Unipile')
  }
}
