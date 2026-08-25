import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
console.log('### campañas de instagram')
console.table(await sql`select c.name, c.status, a.display_name as cuenta,
  (select count(*) from leads l where l.campaign_id=c.id) as leads
  from campaigns c left join accounts a on a.id=c.account_id where c.channel='instagram'`)
console.log('### contactos del imán por estado')
console.table(await sql`select state, count(*) as n, max(updated_at) as ultimo from magnet_contacts group by 1`)
console.log('### leads del imán esperando el "¿qué tal?"')
console.table(await sql`select l.instagram_username, l.status, l.next_action_at, l.touch_count, c.status as campana
  from leads l join campaigns c on c.id=l.campaign_id where c.channel='instagram' order by l.created_at desc limit 6`)
