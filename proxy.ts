import { type NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidApiKey, isValidSession } from "@/lib/auth";

/**
 * Puerta única del dashboard.
 *
 * Se llama `proxy` y no `middleware` porque Next 16 renombró la convención.
 *
 * Dos formas de entrar y ninguna más:
 *   · cookie de sesión firmada  → el humano en el navegador
 *   · cabecera x-api-key        → n8n llamando a la API
 *
 * Se resuelve aquí y no en cada route handler para que añadir una ruta nueva no
 * pueda dejarla abierta por olvido: lo que no está en PUBLIC_PATHS, está cerrado.
 */

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  // Aterrizaje del asistente de Unipile: llega desde otro dominio y la cookie
  // puede no viajar en ese salto. Si esto estuviera protegido, el usuario
  // acabaría en el login creyendo que se le ha cerrado la sesión.
  "/conectado",
  // Webhook de Meta. Tiene que ser público porque quien llama es Meta, que no
  // sabe nada de nuestra cabecera: se autentica con la firma HMAC del cuerpo
  // contra el App Secret, que es más fuerte que una clave compartida.
  "/api/meta/webhook",
  // Política de privacidad y eliminación de datos. Un revisor de Meta las abre
  // sin haber iniciado sesión nunca: detrás del login vería la pantalla de
  // acceso y rechazaría la solicitud por política inaccesible.
  "/legal",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const hasSession = await isValidSession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );
  if (hasSession) return NextResponse.next();

  if (isValidApiKey(request.headers.get("x-api-key")))
    return NextResponse.next();

  // La API contesta 401 en JSON; a n8n no le sirve una redirección a un login.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        error:
          "No autorizado. Falta la cookie de sesión o la cabecera x-api-key.",
      },
      { status: 401 },
    );
  }

  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    // Todo menos los estáticos de Next y el favicon.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
