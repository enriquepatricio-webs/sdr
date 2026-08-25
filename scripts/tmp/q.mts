import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
for (const r of await sql`select t.direction, t.status, t.step, t.body, t.created_at, l.instagram_username
  from touches t join leads l on l.id=t.lead_id
  where t.channel='instagram' order by t.created_at desc limit 4`)
  console.log(`${new Date(r.created_at as any).toISOString()} ${r.direction}/${r.status} @${r.instagram_username} (paso ${r.step})\n   ${r.body}\n`)
