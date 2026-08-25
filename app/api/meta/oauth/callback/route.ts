import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, runLogs } from "@/lib/db/schema";
import { canjearCodigo, quienEs } from "@/lib/instagram";
import { urlDeVuelta } from "../start/route";

export const dynamic = "force-dynamic";

/**
 * La vuelta de Instagram. Aquí es donde una autorización se convierte en token.
 *
 * Termina siempre en una pantalla del panel, con o sin éxito: quien acaba de
 * pulsar "autorizar" está mirando el navegador, y devolverle un JSON crudo es
 * dejarle sin saber si ha funcionado.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const accountId = url.searchParams.get("state");
  const panel = new URL("/empresa", url.origin);

  // Instagram devuelve el motivo cuando la persona cancela o falta un permiso.
  const error =
    url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (error || !code || !accountId) {
    panel.searchParams.set("instagram", "error");
    panel.searchParams.set(
      "motivo",
      error ?? "Instagram no devolvió el código.",
    );
    return NextResponse.redirect(panel);
  }

  try {
    const token = await canjearCodigo(code, urlDeVuelta(request));
    const perfil = await quienEs(token.access_token);

    await db
      .update(accounts)
      .set({
        metaToken: token.access_token,
        metaTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
        igUserId: perfil.id,
        instagramUsername: perfil.username,
        // Autorizar es exactamente lo que la vuelve a poner en marcha.
        status: "active",
      })
      .where(eq(accounts.id, accountId));

    await db.insert(runLogs).values({
      workflow: "instagram",
      level: "info",
      message: `@${perfil.username} autorizó la app. Token válido ${Math.round(token.expires_in / 86400)} días.`,
      payload: { accountId, igUserId: perfil.id },
    });

    panel.searchParams.set("instagram", "ok");
    panel.searchParams.set("usuario", perfil.username);
    return NextResponse.redirect(panel);
  } catch (err) {
    const detalle = err instanceof Error ? err.message : String(err);
    await db.insert(runLogs).values({
      workflow: "instagram",
      level: "error",
      message: `No se pudo completar la autorización de Instagram: ${detalle}`,
      payload: { accountId },
    });
    panel.searchParams.set("instagram", "error");
    panel.searchParams.set("motivo", detalle.slice(0, 200));
    return NextResponse.redirect(panel);
  }
}
