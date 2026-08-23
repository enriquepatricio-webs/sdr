import { and, eq, isNull, ne } from 'drizzle-orm'
import { db } from './db'
import { playbooks } from './db/schema'

/**
 * Deja `id` como el único playbook activo DE SU ÁMBITO.
 *
 * El ámbito es la empresa a la que pertenece, o "global" si no pertenece a
 * ninguna. Antes desactivaba todos los demás sin mirar, y con playbooks por
 * empresa eso significaba que activar el de un cliente apagaba el global y
 * dejaba al resto de empresas sin método de venta.
 *
 * Van dos sentencias en este orden y no una sola, aunque `set is_active = (id = $1)`
 * parezca más limpio: el índice único parcial se comprueba fila a fila durante
 * el UPDATE, así que la versión de una sola sentencia revienta o no según el
 * orden físico de las filas. Comprobado contra Postgres — falla al activar una
 * versión que esté por delante de la activa actual.
 *
 * `batch` las manda en una sola transacción, así que nadie observa el instante
 * intermedio sin ningún playbook activo.
 */
export async function activarPlaybook(id: string): Promise<void> {
  const [destino] = await db
    .select({ workspaceId: playbooks.workspaceId })
    .from(playbooks)
    .where(eq(playbooks.id, id))
  if (!destino) throw new Error('Ese playbook no existe.')

  const mismoAmbito = destino.workspaceId
    ? eq(playbooks.workspaceId, destino.workspaceId)
    : isNull(playbooks.workspaceId)

  await db.batch([
    db
      .update(playbooks)
      .set({ isActive: false })
      .where(and(eq(playbooks.isActive, true), ne(playbooks.id, id), mismoAmbito)),
    db.update(playbooks).set({ isActive: true }).where(eq(playbooks.id, id)),
  ])
}
