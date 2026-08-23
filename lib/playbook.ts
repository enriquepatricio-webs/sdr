import { and, eq, ne, sql } from 'drizzle-orm'
import { db } from './db'
import { playbooks } from './db/schema'

/**
 * Deja `id` como el único playbook activo.
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
  await db.batch([
    db
      .update(playbooks)
      .set({ isActive: false })
      .where(and(eq(playbooks.isActive, true), ne(playbooks.id, id))),
    db.update(playbooks).set({ isActive: true }).where(eq(playbooks.id, id)),
  ])
}

/** Igual pero contra una conexión cualquiera, para poder probarlo. */
export const SQL_DESACTIVAR_RESTO = (id: string) =>
  sql`update playbooks set is_active = false where is_active and id <> ${id}::uuid`
export const SQL_ACTIVAR = (id: string) =>
  sql`update playbooks set is_active = true where id = ${id}::uuid`
