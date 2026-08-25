/**
 * Autenticación del dashboard.
 *
 * La sesión es una cookie firmada con HMAC-SHA256 sobre la fecha de caducidad: sin
 * estado en servidor, sin dependencias, y verificable desde el middleware.
 *
 * Se usa Web Crypto (no `node:crypto`) para que el mismo código valga en el
 * middleware y en los route handlers sin duplicar nada.
 */

export const SESSION_COOKIE = "sdr_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 días

function secret(
  name: "SESSION_SECRET" | "DASHBOARD_PASSWORD" | "N8N_SHARED_SECRET",
): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} no está definida.`);
  return value;
}

/**
 * Comparación en tiempo constante.
 *
 * Un `===` sobre un token sale antes en el primer byte distinto, y esa
 * diferencia de tiempo es medible: permite adivinar el secreto byte a byte.
 * Se comparan siempre todos los caracteres de la longitud mayor.
 */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret("SESSION_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * La sesión lleva a QUIÉN pertenece, no solo hasta cuándo vale.
 *
 * Antes solo firmaba la caducidad, así que todas las sesiones eran idénticas y
 * no se podía saber quién estaba dentro ni revocar a una persona concreta. Con
 * el id firmado dentro, quitar a alguien es borrar su fila.
 */
export async function createSessionToken(
  userId: string,
  now = Date.now(),
): Promise<string> {
  const expiresAt = String(now + SESSION_TTL_MS);
  const cuerpo = `${expiresAt}.${userId}`;
  return `${cuerpo}.${await hmac(cuerpo)}`;
}

/** El id de quien tiene esta sesión, si la firma es buena y no ha caducado. */
export async function usuarioDeSesion(
  token: string | undefined,
  now = Date.now(),
): Promise<string | null> {
  if (!token) return null;
  const [expiresAt, userId, signature] = token.split(".");
  if (!expiresAt || !userId || !signature) return null;
  const esperado = await hmac(`${expiresAt}.${userId}`);
  if (!safeEqual(signature, esperado)) return null;
  const expiry = Number(expiresAt);
  return Number.isFinite(expiry) && expiry > now ? userId : null;
}

export async function isValidSession(
  token: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  return (await usuarioDeSesion(token, now)) !== null;
}

/**
 * Cambiar el formato de la cookie invalida las sesiones abiertas, y está bien.
 *
 * Una sesión creada cuando no existían los usuarios no dice a quién pertenece,
 * así que no se puede revocar ni auditar. Mantenerla viva sería conservar
 * exactamente lo que este cambio viene a quitar. El coste es volver a entrar
 * una vez.
 */

/** Autenticación de n8n: cabecera x-api-key contra N8N_SHARED_SECRET. */
export function isValidApiKey(headerValue: string | null | undefined): boolean {
  if (!headerValue) return false;
  return safeEqual(headerValue, secret("N8N_SHARED_SECRET"));
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_MS / 1000,
} as const;
