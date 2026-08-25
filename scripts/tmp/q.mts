import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
for (const r of await sql`select message, payload, created_at from run_logs
  where workflow='sdr-envio' and message like '%cannot_resend_yet%' order by created_at desc limit 2`)
  console.log(r.created_at, '\n', r.message, '\n', JSON.stringify(r.payload), '\n---')
