import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

/**
 * La conexión se crea al primer uso, no al importar el módulo.
 *
 * Si se creara al importar, cualquier fichero que toque el esquema reventaría
 * en el build de Vercel (donde DATABASE_URL puede no estar disponible todavía)
 * en vez de fallar en la petición concreta que necesita la base de datos.
 */
function connect() {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL no está definida. Copia .env.example a .env.local y rellénala con la cadena de Neon (con ?sslmode=require).',
    )
  }
  return drizzle(neon(url), { schema })
}

let instancia: ReturnType<typeof connect> | null = null

export const db = new Proxy({} as ReturnType<typeof connect>, {
  get(_target, prop) {
    instancia ??= connect()
    return Reflect.get(instancia, prop, instancia)
  },
})

export { schema }
