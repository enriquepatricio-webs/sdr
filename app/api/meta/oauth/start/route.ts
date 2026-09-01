import { NextResponse } from "next/server";
import { urlDeAutorizacion } from "@/lib/instagram";

export const dynamic = "force-dynamic";

/**
 * La URL a la que redirige Instagram al volver.
 *
 * Tiene que coincidir LETRA POR LETRA con la registrada en la app de Meta.
 * Salía de `request.url`, y eso funcionaba en Vercel —donde la petición llega
 * con el dominio público— pero no detrás de un proxy: Caddy habla con el
 * servidor por 127.0.0.1:3000, así que la URL que veía Next era
 * `https://localhost:3000/...` y eso es lo que se le mandaba a Instagram.
 *
 * El síntoma no se parecía a la causa. Instagram no dice "esa URL no está
 * registrada": descarta la petición y deja al usuario en la pantalla de entrar,
 * aunque ya tuviera la sesión abierta. Parece un problema de sesión y es de
 * configuración.
 *
 * Por eso el dominio público se declara, no se adivina. Una URL de retorno de
 * OAuth tiene que ser estable y estar registrada; deducirla de una cabecera que
 * pone quien llama es frágil, y además deja que un `Host` falso decida a dónde
 * vuelve el código de autorización.
 */
export function urlDeVuelta(request: Request): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? request.url;
  return new URL("/api/meta/oauth/callback", base).toString();
}

/**
 * Manda a la persona a Instagram para que autorice la cuenta.
 *
 * El `state` lleva a qué cuenta nuestra se va a enganchar el token. Instagram
 * lo devuelve tal cual al volver, y es la única forma de saberlo: la respuesta
 * de Instagram no dice nada de nosotros.
 */
export async function GET(request: Request) {
  const accountId = new URL(request.url).searchParams.get("account_id");
  if (!accountId) {
    return NextResponse.json(
      { error: "Falta account_id: hay que decir a qué cuenta se engancha." },
      { status: 400 },
    );
  }
  return NextResponse.redirect(
    urlDeAutorizacion(urlDeVuelta(request), accountId),
  );
}
