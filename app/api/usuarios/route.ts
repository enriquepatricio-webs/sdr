import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { jsonError, parseBody, serverError } from "@/lib/api";
import { SESSION_COOKIE, usuarioDeSesion } from "@/lib/auth";
import {
  buscarUsuario,
  crearUsuario,
  listarUsuarios,
  borrarUsuario,
  cambiarContrasena,
} from "@/lib/usuarios";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Solo un administrador gestiona usuarios.
 *
 * La cabecera `x-api-key` de n8n NO vale aquí: sirve para que un workflow mueva
 * leads, no para crear cuentas de acceso. Si valiera, quien tuviera esa clave
 * podría fabricarse un usuario y entrar al panel.
 */
async function admin(): Promise<{ id: string } | null> {
  const galleta = await cookies();
  const id = await usuarioDeSesion(galleta.get(SESSION_COOKIE)?.value);
  if (!id) return null;
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u?.role === "admin" ? { id: u.id } : null;
}

export async function GET() {
  if (!(await admin())) return jsonError("Solo un administrador.", 403);
  try {
    return NextResponse.json({ usuarios: await listarUsuarios() });
  } catch (err) {
    return serverError(err, "No se pudieron leer los usuarios");
  }
}

const nuevo = z.object({
  usuario: z
    .string()
    .min(3, "Al menos 3 caracteres.")
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      "Solo letras, números, punto, guion y guion bajo.",
    ),
  contrasena: z.string().min(10, "Al menos 10 caracteres."),
  rol: z.enum(["admin", "revisor"]).default("revisor"),
});

export async function POST(request: Request) {
  if (!(await admin())) return jsonError("Solo un administrador.", 403);
  const body = await parseBody(request, nuevo);
  if (!body.ok) return body.response;

  try {
    if (await buscarUsuario(body.data.usuario)) {
      return jsonError("Ya existe un usuario con ese nombre.", 409);
    }
    const u = await crearUsuario({
      username: body.data.usuario,
      contrasena: body.data.contrasena,
      role: body.data.rol,
    });
    return NextResponse.json(
      { id: u.id, usuario: u.username, rol: u.role },
      { status: 201 },
    );
  } catch (err) {
    return serverError(err, "No se pudo crear el usuario");
  }
}

const cambio = z.object({
  id: z.string().uuid(),
  contrasena: z.string().min(10, "Al menos 10 caracteres."),
});

export async function PATCH(request: Request) {
  if (!(await admin())) return jsonError("Solo un administrador.", 403);
  const body = await parseBody(request, cambio);
  if (!body.ok) return body.response;
  try {
    await cambiarContrasena(body.data.id, body.data.contrasena);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError(err, "No se pudo cambiar la contraseña");
  }
}

export async function DELETE(request: Request) {
  const yo = await admin();
  if (!yo) return jsonError("Solo un administrador.", 403);
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return jsonError("Falta el id.", 400);
  // Quedarse sin ningún administrador deja el panel inaccesible para siempre.
  if (id === yo.id) return jsonError("No puedes borrarte a ti mismo.", 409);
  try {
    await borrarUsuario(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError(err, "No se pudo borrar el usuario");
  }
}
