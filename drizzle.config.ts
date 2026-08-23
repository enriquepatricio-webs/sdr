import './lib/db/load-env'
import { defineConfig } from 'drizzle-kit'

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL

if (!url) {
  throw new Error(
    'DATABASE_URL no está definida. Copia .env.example a .env.local y rellénala con la cadena de Neon.\n' +
      'Para migraciones usa la conexión DIRECTA (DATABASE_URL_UNPOOLED): PgBouncer en modo transacción rompe el DDL con estado de sesión.',
  )
}

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
})
