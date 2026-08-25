import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
const r = await sql`select level, substring(message from 1 for 200) as msg, payload, created_at from run_logs where workflow='instagram' order by created_at desc limit 2`
for (const x of r) {
  console.log('---', x.created_at, '|', x.level)
  console.log(x.msg)
  console.log('permisos:', JSON.stringify((x.payload as any)?.permisos))
}
