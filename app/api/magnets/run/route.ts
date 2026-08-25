import { NextResponse } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, leadMagnets, runLogs } from "@/lib/db/schema";
import { serverError } from "@/lib/api";
import { atenderComentarios } from "@/lib/magnets-meta";
import { minutosEntreLecturas } from "@/lib/magnets";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * La vuelta periódica a los imanes. Es la red por debajo del webhook.
 *
 * Lo normal es que Meta avise y el recurso salga en medio segundo. Pero un
 * aviso se puede perder: la suscripción de una cuenta se cae, Meta reintenta
 * mientras estamos desplegando, alguien comenta justo cuando caduca el token.
 * Cuando eso pasa, el comentario se queda sin contestar y nadie se entera,
 * porque desde fuera un imán mudo se ve igual que un imán sin comentarios.
 *
 * n8n la llama cada quince minutos. Existía la llamada y no la ruta: caía en
 * `/api/magnets/[id]` con id="run" y devolvía 405, así que durante todo ese
 * tiempo la red no estuvo puesta.
 */
export async function POST() {
  try {
    const imanes = await db
      .select({ iman: leadMagnets, cuenta: accounts })
      .from(leadMagnets)
      .innerJoin(accounts, eq(accounts.id, leadMagnets.accountId))
      .where(and(eq(leadMagnets.active, true), isNotNull(accounts.metaToken)));

    const ahora = new Date();
    const hechos: Record<string, unknown>[] = [];

    for (const { iman } of imanes) {
      /**
       * No se relee en cada vuelta: se relee cuando toca.
       *
       * Los comentarios de una publicación llegan casi todos en las primeras
       * horas. Un imán de hace un mes no necesita que le pregunten cada cuarto
       * de hora, y cada lectura es una llamada a Meta que cuenta para su tope.
       */
      const cada = minutosEntreLecturas(iman.createdAt, ahora);
      const ultima = iman.comentariosLeidosAt;
      if (ultima && ahora.getTime() - ultima.getTime() < cada * 60_000) continue;

      const r = await atenderComentarios(iman.id, { ensayo: false });
      await db
        .update(leadMagnets)
        .set({ comentariosLeidosAt: ahora })
        .where(eq(leadMagnets.id, iman.id));

      hechos.push({
        iman: iman.name,
        leidos: r.comentariosLeidos,
        conLaClave: r.conLaClave,
        nuevos: r.nuevos,
        error: r.error ?? null,
      });

      /**
       * Solo se registra cuando pasa algo o cuando falla.
       *
       * Una vuelta cada quince minutos que no encuentra nada son noventa y seis
       * líneas al día que solo dicen "nada": el registro deja de servir para
       * encontrar lo que sí importa.
       */
      if (r.nuevos > 0 || r.error) {
        await db.insert(runLogs).values({
          workflow: "iman",
          level: r.error ? "warn" : "info",
          message: r.error
            ? `La vuelta periódica no pudo leer "${iman.name}": ${r.error}`
            : `La vuelta periódica recogió ${r.nuevos} comentario(s) que el webhook no trajo en "${iman.name}".`,
          payload: { magnetId: iman.id },
        });
      }
    }

    return NextResponse.json({ imanes: imanes.length, hechos });
  } catch (err) {
    return serverError(err, "No se pudo dar la vuelta a los imanes");
  }
}
