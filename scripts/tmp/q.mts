import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
console.table(await sql`update lead_magnets set active=true where not active returning name, active`)
