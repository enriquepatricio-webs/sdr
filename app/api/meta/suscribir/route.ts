import { NextResponse } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { serverError } from "@/lib/api";
import { suscribirCuenta, suscripciones } from "@/lib/instagram";
import { tokenDeCuenta } from "@/lib/instagram-cuenta";

export const dynamic = "force-dynamic";

/**
 * Suscribe a los avisos las cuentas ya autorizadas.
 *
 * Existe para las que se autorizaron antes de que la suscripción fuera parte
 * del proceso. Es idempotente: suscribir dos veces no hace nada.
 */
export async function POST() {
  try {
    const cuentas = await db
      .select({ id: accounts.id, nombre: accounts.displayName })
      .from(accounts)
      .where(
        and(eq(accounts.provider, "instagram"), isNotNull(accounts.metaToken)),
      );

    const hechas = [];
    for (const c of cuentas) {
      const cuenta = await tokenDeCuenta(c.id);
      if (!cuenta) continue;
      try {
        await suscribirCuenta(cuenta.token);
        hechas.push({
          cuenta: `@${cuenta.username}`,
          suscrita: await suscripciones(cuenta.token),
        });
      } catch (err) {
        hechas.push({
          cuenta: `@${cuenta.username ?? c.nombre}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return NextResponse.json({ cuentas: hechas });
  } catch (err) {
    return serverError(err, "No se pudo suscribir");
  }
}
