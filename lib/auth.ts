/**
 * Autenticación del dashboard: un solo usuario, una sola contraseña.
 *
 * No hay tabla de usuarios ni registro porque no hay más que una persona. La
 * sesión es una cookie firmada con HMAC-SHA256 sobre la fecha de caducidad: sin
 * estado en servidor, sin dependencias, y verificable desde el middleware.
 *
 * Se usa Web Crypto (no `node:crypto`) para que el mismo código valga en el
 * middleware y en los route handlers sin duplicar nada.
 */

export const SESSION_COOKIE = 'sdr_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 días

function secret(name: 'SESSION_SECRET' | 'DASHBOARD_PASSWORD' | 'N8N_SHARED_SECRET'): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} no está definida.`)
  return value
}

/**
 * Comparación en tiempo constante.
 *
 * Un `===` sobre un token sale antes en el primer byte distinto, y esa
 * diferencia de tiempo es medible: permite adivinar el secreto byte a byte.
 * Se comparan siempre todos los caracteres de la longitud mayor.
 */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret('SESSION_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function createSessionToken(now = Date.now()): Promise<string> {
  const expiresAt = String(now + SESSION_TTL_MS)
  return `${expiresAt}.${await hmac(expiresAt)}`
}

export async function isValidSession(token: string | undefined, now = Date.now()): Promise<boolean> {
  if (!token) return false
  const [expiresAt, signature] = token.split('.')
  if (!expiresAt || !signature) return false

  // Se verifica la firma SIEMPRE, también cuando ya ha caducado: salir antes
  // por caducidad convierte el endpoint en un oráculo de tokens válidos.
  const expected = await hmac(expiresAt)
  const signatureOk = safeEqual(signature, expected)

  const expiry = Number(expiresAt)
  const notExpired = Number.isFinite(expiry) && expiry > now
  return signatureOk && notExpired
}

export function isValidPassword(candidate: string): boolean {
  return safeEqual(candidate, secret('DASHBOARD_PASSWORD'))
}

/** Autenticación de n8n: cabecera x-api-key contra N8N_SHARED_SECRET. */
export function isValidApiKey(headerValue: string | null | undefined): boolean {
  if (!headerValue) return false
  return safeEqual(headerValue, secret('N8N_SHARED_SECRET'))
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: SESSION_TTL_MS / 1000,
} as const
