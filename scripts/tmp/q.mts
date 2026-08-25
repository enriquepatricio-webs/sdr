import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
console.log('### la consulta acotada por cuenta, tal cual la hace el código')
for (const c of await sql`select provider_id, username from magnet_contacts where provider_id is not null`) {
  const [fila] = await sql`
    select mc.username, a.display_name, a.ig_user_id
    from magnet_contacts mc
    join lead_magnets m on m.id=mc.magnet_id
    join accounts a on a.id=m.account_id
    where mc.provider_id=${c.provider_id} and a.ig_user_id='17841436619898247'`
  console.log(`  @${c.username} -> ${fila ? 'CASA con ' + fila.display_name : 'NO CASA'}`)
}
