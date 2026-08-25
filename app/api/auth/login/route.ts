import { NextResponse } from "next/server";
import { z } from "zod";
import {
  SESSION_COOKIE,
  createSessionToken,
  sessionCookieOptions,
} from "@/lib/auth";
import { jsonError, parseBody } from "@/lib/api";
import {
  asegurarAdmin,
  buscarUsuario,
  contrasenaCorrecta,
  marcarEntrada,
} from "@/lib/usuarios";

const schema = z.object({
  usuario: z.string().min(1, "Falta el usuario."),
  password: z.string().min(1, "Falta la contraseña."),
});

export async function POST(request: Request) {
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;

  // El primer administrador se crea solo, con la contraseña que ya existía.
  // Así el cambio a usuarios con nombre no deja a nadie fuera.
  await asegurarAdmin();

  const usuario = await buscarUsuario(body.data.usuario);
  /**
   * Se comprueba la contraseña incluso cuando el usuario no existe.
   *
   * Salir antes hace que un usuario inexistente responda más rápido que uno
   * real, y esa diferencia de tiempo permite averiguar qué nombres existen sin
   * acertar ni una contraseña.
   */
  const guardado =
    usuario?.passwordHash ??
    "scrypt$00000000000000000000000000000000$" + "0".repeat(128);
  const vale = await contrasenaCorrecta(body.data.password, guardado);

  if (!usuario || !vale) {
    // Vago y sin distinguir causas: decir "ese usuario no existe" es regalar
    // media credencial.
    return jsonError("Usuario o contraseña incorrectos.", 401);
  }

  await marcarEntrada(usuario.id);
  const response = NextResponse.json({ ok: true, usuario: usuario.username });
  response.cookies.set(
    SESSION_COOKIE,
    await createSessionToken(usuario.id),
    sessionCookieOptions,
  );
  return response;
}
