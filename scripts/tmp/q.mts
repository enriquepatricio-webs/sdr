import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
const r = await sql`select payload, created_at from run_logs where workflow='meta-webhook' and level='info' order by created_at desc limit 2`
for (const x of r) { console.log('---', x.created_at); console.log(JSON.stringify(x.payload).slice(0, 900)) }
