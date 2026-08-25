import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
console.table(await sql`
  select level, substring(message from 1 for 260) as msg, created_at
  from run_logs where workflow='instagram' order by created_at desc limit 4`)
