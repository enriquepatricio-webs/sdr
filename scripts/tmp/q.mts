import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
// Deshago la reserva que ha provocado mi comprobación: n8n lo cogerá en su próxima vuelta.
const r = await sql`update leads set next_action_at = now()
  where instagram_username='sofadelempresario' and status='contactado' returning instagram_username, next_action_at`
console.table(r)
