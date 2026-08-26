import { NextResponse } from "next/server";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  leadMagnets,
  magnetContacts,
  runLogs,
} from "@/lib/db/schema";
import { serverError } from "@/lib/api";
import { atenderComentarios } from "@/lib/magnets-meta";
import {
  HORAS_HASTA_EL_RECORDATORIO,
  MAX_PETICIONES_DE_FOLLOW,
  PEDIR_FOLLOW_SIN_SABER,
  minutosEntreLecturas,
} from "@/lib/magnets";
import { mensajeDirecto } from "@/lib/instagram";
import { tokenDeCuenta } from "@/lib/instagram-cuenta";

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

    const recordados = await recordarElFollow();

    return NextResponse.json({ imanes: imanes.length, hechos, recordados });
  } catch (err) {
    return serverError(err, "No se pudo dar la vuelta a los imanes");
  }
}

/**
 * Recuerda el follow a quien lo pidió y no ha vuelto a dar señales.
 *
 * Antes solo se le recordaba cuando esa persona VOLVÍA a escribir, así que
 * quien comentaba, veía el mensaje y se despistaba no recibía nada más nunca.
 * Se quedaba esperando un recurso que no iba a llegar.
 *
 * Hay un límite físico que conviene entender antes de tocar esto: si esa
 * persona no ha aceptado la solicitud de mensaje, Instagram responde "podrás
 * enviar más mensajes cuando se acepte tu invitación para chatear" y no hay
 * forma de llegar a ella. Se intenta igual en cada vuelta —cuesta una llamada y
 * entra sola en cuanto acepte— pero un fallo así NO cuenta como recordatorio:
 * gastar uno de los cinco avisos en un mensaje que nadie ha recibido dejaría a
 * esa persona sin sus intentos de verdad.
 */
async function recordarElFollow(): Promise<Record<string, unknown>[]> {
  const desde = new Date(
    Date.now() - HORAS_HASTA_EL_RECORDATORIO * 3600_000,
  );

  const esperando = await db
    .select({ contacto: magnetContacts, cuentaId: leadMagnets.accountId })
    .from(magnetContacts)
    .innerJoin(leadMagnets, eq(leadMagnets.id, magnetContacts.magnetId))
    .where(
      and(
        eq(magnetContacts.state, "pidiendo_follow"),
        isNotNull(magnetContacts.providerId),
        lt(magnetContacts.updatedAt, desde),
        lt(magnetContacts.followAsks, MAX_PETICIONES_DE_FOLLOW),
        // Pasada una semana se deja de insistir: quien no ha vuelto en siete
        // días no va a volver, y seguir llamando a Meta por él no es gratis.
        sql`${magnetContacts.createdAt} > now() - interval '7 days'`,
      ),
    );

  const hechos: Record<string, unknown>[] = [];
  for (const { contacto, cuentaId } of esperando) {
    const cuenta = await tokenDeCuenta(cuentaId);
    if (!cuenta) continue;
    try {
      await mensajeDirecto(
        cuenta.token,
        cuenta.igUserId,
        contacto.providerId!,
        // No se afirma que no siga: no se puede saber hasta que escriba.
        PEDIR_FOLLOW_SIN_SABER,
      );
      await db
        .update(magnetContacts)
        .set({ followAsks: contacto.followAsks + 1 })
        .where(eq(magnetContacts.id, contacto.id));
      await db.insert(runLogs).values({
        workflow: "iman",
        level: "info",
        message: `Recordatorio del follow a @${contacto.username} (aviso ${contacto.followAsks + 1} de ${MAX_PETICIONES_DE_FOLLOW}).`,
        payload: { contactId: contacto.id },
      });
      hechos.push({ usuario: contacto.username, recordado: true });
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      // El caso normal: todavía no ha aceptado la solicitud. No es una avería y
      // no merece un aviso cada dos minutos en el registro.
      const sinAceptar = motivo.includes("1545120") || motivo.includes("invitaci");
      if (!sinAceptar) {
        await db.insert(runLogs).values({
          workflow: "iman",
          level: "warn",
          message: `No se pudo recordar el follow a @${contacto.username}: ${motivo.slice(0, 200)}`,
          payload: { contactId: contacto.id },
        });
      }
      hechos.push({
        usuario: contacto.username,
        recordado: false,
        motivo: sinAceptar ? "no ha aceptado la solicitud de mensaje" : motivo.slice(0, 80),
      });
    }
  }
  return hechos;
}
