import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
console.log('--- contacto y su lead ---')
console.table(await sql`
  select mc.username, mc.state, mc.lead_id, mc.provider_id, mc.unipile_chat_id,
         l.status as lead_status, l.campaign_id
  from magnet_contacts mc left join leads l on l.id=mc.lead_id`)
console.log('--- toques de ese lead ---')
console.table(await sql`
  select t.direction, t.status, t.step, substring(t.body from 1 for 55) as texto, t.created_at
  from touches t where t.lead_id in (select lead_id from magnet_contacts where lead_id is not null)
  order by t.created_at`)
console.log('--- frescura de seguidores ---')
console.table(await sql`select column_name from information_schema.columns where table_name like '%follower%' or table_name like '%seguid%'`)
