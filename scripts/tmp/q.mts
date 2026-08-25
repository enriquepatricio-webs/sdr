import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
for (const r of await sql`select workflow, level, message, payload, created_at from run_logs
  where created_at between '2026-08-25T13:25:00Z' and '2026-08-25T13:45:00Z' order by created_at`)
  console.log(`${new Date(r.created_at as any).toISOString()} [${r.level}] ${r.workflow}: ${r.message}`.slice(0,180),
    r.payload ? '\n   ' + JSON.stringify(r.payload).slice(0,400) : '')
