import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
console.table(await sql`
  select substring(message from 1 for 190) as msg, created_at from run_logs
  where (message ilike '%calendar%' or message ilike '%composio%')
    and created_at > now() - interval '10 minutes' order by created_at desc limit 2`)
