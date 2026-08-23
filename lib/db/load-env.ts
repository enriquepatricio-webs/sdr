/**
 * Carga de entorno para los scripts de línea de comandos.
 *
 * Next.js lee `.env.local` y `.env` por su cuenta, pero drizzle-kit y tsx no:
 * `import 'dotenv/config'` solo mira `.env`. Sin esto, poner los secretos en
 * `.env.local` (que es lo que dice la documentación) hace fallar db:migrate,
 * db:push y db:seed con un error que no explica por qué.
 *
 * Mismo orden de precedencia que Next.js: `.env.local` pisa a `.env`.
 */
import { config } from 'dotenv'

config({ path: ['.env.local', '.env'] })
