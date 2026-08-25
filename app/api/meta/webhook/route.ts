import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runLogs } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/**
 * Por donde Meta nos cuenta lo que pasa en Instagram.
 *
 * Sustituye a mirar la publicación cada dos minutos con Apify: en vez de
 * preguntar, Meta avisa. Es lo que hace que ManyChat conteste en segundos y
 * gratis, y es la única forma de que un comentario dispare un DM al instante.
 *
 * De momento solo verifica y guarda. Enganchar el evento `comments` al embudo
 * —que sigue entero en `lib/magnets.ts`— necesita los tokens de cada cuenta,
 * que llegan cuando la app esté aprobada. Guardar desde ya sirve para ver la
 * forma real de los eventos antes de escribir nada contra ella.
 */

/** Meta valida la URL con un GET antes de dejar guardar la suscripción. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const modo = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const reto = url.searchParams.get("hub.challenge");

  const esperado = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!esperado) {
    return new NextResponse("Falta META_WEBHOOK_VERIFY_TOKEN.", {
      status: 500,
    });
  }
  if (modo !== "subscribe" || token !== esperado || !reto) {
    // Sin detalle a propósito: este endpoint es público y decir POR QUÉ falla
    // lo convierte en un oráculo para adivinar el token.
    return new NextResponse("No.", { status: 403 });
  }

  // Meta espera el reto tal cual, en texto plano. Un JSON aquí y la
  // verificación falla sin decir nada útil.
  return new NextResponse(reto, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * La firma es lo único que separa esto de un endpoint que cualquiera puede
 * usar para inventarse comentarios.
 *
 * Se calcula sobre el cuerpo EN CRUDO: volver a serializar el JSON cambia
 * espacios y orden y la firma deja de cuadrar.
 */
type Veredicto = { vale: boolean; motivo: string; calculada?: string };

function firmaValida(crudo: string, cabecera: string | null): Veredicto {
  const secreto = process.env.META_APP_SECRET;
  if (!secreto) return { vale: false, motivo: "no hay META_APP_SECRET" };
  if (!cabecera) {
    return { vale: false, motivo: "la petición no trae x-hub-signature-256" };
  }
  if (!cabecera.startsWith("sha256=")) {
    return { vale: false, motivo: `la firma no empieza por sha256=` };
  }

  const esperada = createHmac("sha256", secreto).update(crudo).digest();
  const recibida = Buffer.from(cabecera.slice("sha256=".length), "hex");
  if (recibida.length !== esperada.length) {
    return { vale: false, motivo: "la firma no mide 32 bytes" };
  }
  if (!timingSafeEqual(recibida, esperada)) {
    return {
      vale: false,
      motivo: "la firma no cuadra con el secreto",
      calculada: esperada.toString("hex"),
    };
  }
  return { vale: true, motivo: "ok" };
}

export async function POST(request: Request) {
  const crudo = await request.text();
  const cabecera = request.headers.get("x-hub-signature-256");
  const veredicto = firmaValida(crudo, cabecera);

  if (!veredicto.vale) {
    /**
     * Un rechazo tiene que dejar rastro.
     *
     * Meta reintenta lo que no contesta 200 y en su panel eso sigue saliendo
     * como "se probó correctamente el campo": desde su lado la entrega salió
     * bien. Sin este registro, un secreto mal pegado es indistinguible de una
     * suscripción que no se guardó, y las dos se ven igual: silencio.
     *
     * No se guarda el secreto en ningún caso. Sí la firma calculada, que es un
     * hash y no permite recuperarlo, porque compararla con la que manda Meta es
     * lo único que separa "el secreto es otro" de "el cuerpo llegó cambiado".
     */
    await db.insert(runLogs).values({
      workflow: "meta-webhook",
      level: "warn",
      message: `Evento de Meta rechazado: ${veredicto.motivo}`,
      payload: {
        motivo: veredicto.motivo,
        firmaRecibida: cabecera,
        firmaCalculada: veredicto.calculada ?? null,
        // Cuánto mide el secreto, no el secreto. Un valor mal pegado —el App ID
        // en vez de la clave, o con un salto de línea detrás— se ve aquí.
        largoDelSecreto: process.env.META_APP_SECRET?.length ?? 0,
        bytesDelCuerpo: crudo.length,
        cuerpo: crudo.slice(0, 500),
      },
    });
    return new NextResponse("No.", { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(crudo);
  } catch {
    return new NextResponse("No.", { status: 400 });
  }

  await db.insert(runLogs).values({
    workflow: "meta-webhook",
    level: "info",
    message: "Evento de Meta recibido",
    payload: payload as Record<string, unknown>,
  });

  // Meta reintenta lo que no conteste 200 rápido, así que se responde antes de
  // hacer nada más. Lo que haya que procesar se procesa desde lo guardado.
  return new NextResponse("", { status: 200 });
}
