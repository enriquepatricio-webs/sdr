import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
const desde = new Date().toISOString()
for (let i = 0; i < 90; i++) {
  const r = await sql`
    select t.status, l.full_name, t.created_at
    from touches t join leads l on l.id=t.lead_id join campaigns c on c.id=l.campaign_id
    where c.channel='linkedin' and t.created_at > ${desde}
    order by t.created_at desc limit 3`
  if (r.length) {
    for (const x of r) console.log(x.status, '|', x.full_name, '|', x.created_at)
    process.exit(0)
  }
  await new Promise((r) => setTimeout(r, 20_000))
}
console.log('sin intentos de linkedin en 30 minutos')
