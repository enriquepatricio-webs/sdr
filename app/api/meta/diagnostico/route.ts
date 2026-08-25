import { NextResponse } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Qué acepta de verdad el token que nos ha dado Meta.
 *
 * Su documentación dice una cosa y su API responde otra: el mismo
 * "Unsupported request - method type: get" sale tanto si la ruta está mal como
 * si el token es de otro tipo, y desde fuera no se distinguen. Probar varias
 * rutas con el token REAL y comparar los errores es lo único que lo separa.
 *
 * No devuelve el token, solo qué contesta cada sitio.
 */
const PRUEBAS = (id: string) => [
  {
    que: "perfil",
    url: `https://graph.instagram.com/me?fields=user_id,username`,
  },
  {
    que: "publicaciones",
    url: `https://graph.instagram.com/me/media?fields=id,permalink,media_type,timestamp&limit=25`,
  },
];

export async function GET() {
  try {
    const [cuenta] = await db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.provider, "instagram"), isNotNull(accounts.metaToken)),
      )
      .limit(1);

    if (!cuenta?.metaToken) {
      return NextResponse.json(
        { error: "Ninguna cuenta tiene token todavía." },
        { status: 404 },
      );
    }

    const resultados = [];
    for (const p of PRUEBAS(cuenta.igUserId ?? "me")) {
      const res = await fetch(
        `${p.url}&access_token=${encodeURIComponent(cuenta.metaToken)}`,
        {
          cache: "no-store",
        },
      );
      const texto = await res.text();
      resultados.push({
        que: p.que,
        estado: res.status,
        respuesta: texto.slice(0, 1800),
      });
    }

    return NextResponse.json({
      cuenta: cuenta.displayName,
      igUserId: cuenta.igUserId,
      caduca: cuenta.metaTokenExpiresAt,
      largoDelToken: cuenta.metaToken.length,
      resultados,
    });
  } catch (err) {
    return serverError(err, "No se pudo diagnosticar");
  }
}
