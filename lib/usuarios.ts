import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { db } from "./db";
import { users } from "./db/schema";

const derivar = promisify(scrypt) as (
  clave: string,
  sal: Buffer,
  largo: number,
) => Promise<Buffer>;

/**
 * scrypt y no SHA: una contraseña no se protege con un hash rápido.
 *
 * SHA-256 se calcula miles de millones de veces por segundo en una tarjeta
 * gráfica, así que un volcado de la base se convierte en un diccionario en una
 * tarde. scrypt está diseñado para ser lento y para necesitar memoria, que es
 * lo que hace que probar a fuerza bruta no compense.
 *
 * Va en node:crypto, sin dependencias nuevas.
 */
const LARGO = 64;

export async function hashDeContrasena(contrasena: string): Promise<string> {
  const sal = randomBytes(16);
  const hash = await derivar(contrasena, sal, LARGO);
  return `scrypt$${sal.toString("hex")}$${hash.toString("hex")}`;
}

export async function contrasenaCorrecta(
  contrasena: string,
  guardado: string,
): Promise<boolean> {
  const [algoritmo, salHex, hashHex] = guardado.split("$");
  if (algoritmo !== "scrypt" || !salHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, "hex");
  const calculado = await derivar(
    contrasena,
    Buffer.from(salHex, "hex"),
    esperado.length,
  );
  // En tiempo constante: comparar byte a byte con `===` filtra por dónde falla.
  return timingSafeEqual(calculado, esperado);
}

export type Usuario = typeof users.$inferSelect;

export async function buscarUsuario(username: string): Promise<Usuario | null> {
  const [u] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`);
  return u ?? null;
}

export async function crearUsuario(opciones: {
  username: string;
  contrasena: string;
  role?: string;
}): Promise<Usuario> {
  const [u] = await db
    .insert(users)
    .values({
      username: opciones.username.trim(),
      passwordHash: await hashDeContrasena(opciones.contrasena),
      role: opciones.role ?? "admin",
    })
    .returning();
  return u;
}

export async function cambiarContrasena(
  id: string,
  contrasena: string,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash: await hashDeContrasena(contrasena) })
    .where(eq(users.id, id));
}

export async function borrarUsuario(id: string): Promise<void> {
  await db.delete(users).where(eq(users.id, id));
}

export async function listarUsuarios(): Promise<
  { id: string; username: string; role: string; lastLoginAt: Date | null }[]
> {
  return db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .orderBy(users.createdAt);
}

/**
 * Crea el primer administrador si no hay ninguno.
 *
 * Su contraseña es la que ya estaba en `DASHBOARD_PASSWORD`, a propósito: así
 * el cambio no deja a nadie fuera ni obliga a inventar y transmitir una
 * contraseña nueva por un canal cualquiera. Se puede cambiar desde el panel.
 */
export async function asegurarAdmin(): Promise<void> {
  const [hay] = await db.select({ id: users.id }).from(users).limit(1);
  if (hay) return;
  const inicial = process.env.DASHBOARD_PASSWORD;
  if (!inicial) return;
  await crearUsuario({ username: "admin", contrasena: inicial, role: "admin" });
}

export async function marcarEntrada(id: string): Promise<void> {
  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, id));
}
