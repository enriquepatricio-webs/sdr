import { NextResponse } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Qué deja hacer de verdad el token, probado contra datos reales.
 *
 * La documentación de Meta dice una cosa y su API responde otra, y el mismo
 * error sale por motivos distintos. Probar con el token y los datos de verdad
 * es lo único que lo aclara. No devuelve el token, solo qué contesta cada sitio.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
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
        { error: "Ninguna cuenta autorizada." },
        { status: 404 },
      );
    }
    const t = cuenta.metaToken;
    const G = "https://graph.instagram.com";
    const leer = async (ruta: string) => {
      const res = await fetch(
        `${G}${ruta}${ruta.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(t)}`,
        { cache: "no-store" },
      );
      return { estado: res.status, cuerpo: (await res.text()).slice(0, 700) };
    };

    // Quien comentó de verdad, para poder preguntar por él.
    const personaId = url.searchParams.get("persona");
    if (personaId) {
      return NextResponse.json({
        persona: personaId,
        seguimiento: await leer(
          `/${personaId}?fields=name,username,is_user_follow_business,is_business_follow_user`,
        ),
      });
    }

    const media = await leer("/me/media?fields=id,permalink&limit=5");
    const primera = JSON.parse(media.cuerpo).data?.[0]?.id;
    const comentarios = primera
      ? await leer(`/${primera}/comments?fields=id,text,username,from&limit=10`)
      : { estado: 0, cuerpo: "sin publicaciones" };

    return NextResponse.json({
      cuenta: cuenta.instagramUsername,
      media,
      comentarios,
    });
  } catch (err) {
    return serverError(err, "No se pudo diagnosticar");
  }
}
