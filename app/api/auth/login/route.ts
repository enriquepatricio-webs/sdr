import { NextResponse } from 'next/server'
import { z } from 'zod'
import { SESSION_COOKIE, createSessionToken, isValidPassword, sessionCookieOptions } from '@/lib/auth'
import { jsonError, parseBody } from '@/lib/api'

const schema = z.object({ password: z.string().min(1, 'Falta la contraseña.') })

export async function POST(request: Request) {
  const body = await parseBody(request, schema)
  if (!body.ok) return body.response

  if (!isValidPassword(body.data.password)) {
    // Mensaje deliberadamente vago y sin distinguir causas.
    return jsonError('Contraseña incorrecta.', 401)
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.set(SESSION_COOKIE, await createSessionToken(), sessionCookieOptions)
  return response
}
