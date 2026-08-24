import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
console.table(await sql`select username, state, follow_asks, verified_at, delivered_at from magnet_contacts`)
console.table(await sql`select level, substring(message from 1 for 100) as msg, created_at from run_logs where workflow='iman' order by created_at desc limit 5`)
