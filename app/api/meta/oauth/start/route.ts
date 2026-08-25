import { NextResponse } from "next/server";
import { urlDeAutorizacion } from "@/lib/instagram";

export const dynamic = "force-dynamic";

/** La URL a la que redirige Instagram al volver. Tiene que coincidir LETRA POR
 * LETRA con la registrada en la app de Meta, o el canje del código falla con un
 * error que solo dice "redirect_uri mismatch". */
export function urlDeVuelta(request: Request): string {
  return new URL("/api/meta/oauth/callback", request.url).toString();
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
