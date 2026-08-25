import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
const [c] = await sql`select id, display_name, meta_token from accounts where provider='instagram' and meta_token is not null limit 1`
const res = await fetch(`https://graph.instagram.com/v23.0/me?fields=id,user_id,username`, {
  headers: { Authorization: `Bearer ${c.meta_token}` }, cache: 'no-store' })
const perfil = await res.json()
console.log('Meta dice:', JSON.stringify(perfil))
if (perfil.user_id) {
  await sql`update accounts set ig_user_id=${String(perfil.user_id)} where id=${c.id}`
  console.log('guardado ig_user_id =', perfil.user_id)
}
