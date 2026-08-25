import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
const [pb] = await sql`select id from playbooks where is_active order by (workspace_id is null) limit 1`
console.log('playbook activo:', pb?.id)
const r = await sql`
  update campaigns set status='running', playbook_id = coalesce(playbook_id, ${pb.id}::uuid)
  where channel='instagram' and name like 'Imán:%' and status <> 'running'
  returning name, status`
console.table(r)
console.table(await sql`select name, status from campaigns where channel='instagram'`)
