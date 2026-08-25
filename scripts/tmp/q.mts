import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL!)
console.table(await sql`select username, role, substring(password_hash from 1 for 12) as hash, created_at from users`)
