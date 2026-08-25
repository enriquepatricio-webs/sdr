import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, after } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, leadMagnets, runLogs } from "@/lib/db/schema";
import { atenderComentarios, atenderMensaje } from "@/lib/magnets-meta";

export const dynamic = "force-dynamic";

/**
 * Por donde Meta nos cuenta lo que pasa en Instagram.
 *
 * Sustituye a mirar la publicación cada dos minutos con Apify: en vez de
 * preguntar, Meta avisa. Es lo que hace que ManyChat conteste en segundos y
 * gratis, y es la única forma de que un comentario dispare un DM al instante.
 *
 * Cada evento se atiende contra la cuenta que lo ha recibido, que viene en
 * `entry[].id`. Es lo que permite tener varias cuentas conectadas a la vez sin
 * que una conteste con el token de otra.
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

/**
 * Los dos secretos que puede estar usando Meta.
 *
 * El webhook vive dentro del producto Instagram, que tiene su PROPIA clave,
 * distinta de la de la app padre. Cuál de las dos firma no está claro en su
 * documentación y el error es idéntico en los dos casos, así que se prueban las
 * dos: son nuestras las dos, y aceptar la que cuadre no debilita nada.
 */
function secretos(): string[] {
  return [process.env.META_APP_SECRET, process.env.INSTAGRAM_APP_SECRET].filter(
    (s): s is string => Boolean(s),
  );
}

function firmaValida(crudo: string, cabecera: string | null): Veredicto {
  const todos = secretos();
  if (todos.length === 0) {
    return { vale: false, motivo: "no hay ningún secreto configurado" };
  }
  const secreto = todos[0];
  if (!cabecera) {
    return { vale: false, motivo: "la petición no trae x-hub-signature-256" };
  }
  if (!cabecera.startsWith("sha256=")) {
    return { vale: false, motivo: `la firma no empieza por sha256=` };
  }

  const recibida = Buffer.from(cabecera.slice("sha256=".length), "hex");
  if (recibida.length !== 32) {
    return { vale: false, motivo: "la firma no mide 32 bytes" };
  }
  for (const s of todos) {
    const esperada = createHmac("sha256", s).update(crudo).digest();
    if (timingSafeEqual(recibida, esperada))
      return { vale: true, motivo: "ok" };
  }
  return {
    vale: false,
    motivo: "la firma no cuadra con ninguno de los secretos",
    calculada: createHmac("sha256", secreto).update(crudo).digest("hex"),
  };
}

type PayloadMeta = {
  entry?: {
    /**
     * La cuenta de Instagram que ha recibido el evento.
     *
     * Es el dato que hace que esto funcione con más de una cuenta conectada.
     * Sin él, un mensaje se buscaba solo por quién escribe, y con dos cuentas
     * el mismo identificador podía resolver a la fila de la otra: se habría
     * contestado con el token que no era.
     */
    id?: string;
    changes?: { field?: string; value?: { from?: { id?: string } } }[];
    /** Mensajes entrantes. Vienen en `messaging`, no en `changes`. */
    messaging?: {
      sender?: { id?: string };
      message?: { text?: string; is_echo?: boolean };
    }[];
  }[];
};

/**
 * Atiende los imanes encendidos de las cuentas autorizadas.
 *
 * No se busca el imán exacto del evento a propósito: `atenderComentarios` relee
 * y deduplica por su cuenta, así que pasarle de más no manda nada de más, y a
 * cambio no hay que casar identificadores de media que Meta nombra de tres
 * formas distintas.
 */
async function atenderTodosLosImanes(igUserId?: string): Promise<void> {
  try {
    /**
     * Solo los imanes de la cuenta que ha recibido el aviso.
     *
     * Si no se puede resolver cuál es —un evento de prueba, una cuenta que aún
     * no ha terminado de autorizar— se atienden todos. Releer de más no manda
     * nada de más, porque `atenderComentarios` deduplica; no atender es perder
     * el comentario, que es el fallo caro.
     */
    const deLaCuenta = igUserId
      ? await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.igUserId, igUserId))
      : [];

    const imanes = await db
      .select({ id: leadMagnets.id })
      .from(leadMagnets)
      .innerJoin(accounts, eq(accounts.id, leadMagnets.accountId))
      .where(
        and(
          eq(leadMagnets.active, true),
          isNotNull(accounts.metaToken),
          ...(deLaCuenta.length
            ? [eq(leadMagnets.accountId, deLaCuenta[0].id)]
            : []),
        ),
      );

    for (const iman of imanes) {
      const r = await atenderComentarios(iman.id, { ensayo: false });
      if (r.error) {
        await db.insert(runLogs).values({
          workflow: "iman",
          level: "warn",
          message: `El imán no pudo atender el comentario: ${r.error}`,
          payload: { magnetId: iman.id },
        });
      }
    }
  } catch (err) {
    await db.insert(runLogs).values({
      workflow: "iman",
      level: "error",
      message: `Falló atender un comentario entrante: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

async function atenderMensajeEntrante(
  igsid: string,
  texto: string,
  igUserId?: string,
): Promise<void> {
  try {
    const r = await atenderMensaje(igsid, texto, igUserId);
    if (r.atendido) {
      await db.insert(runLogs).values({
        workflow: "iman",
        level: "info",
        message: `Mensaje de un contacto del imán: ${r.que}`,
        payload: { igsid },
      });
    }
  } catch (err) {
    await db.insert(runLogs).values({
      workflow: "iman",
      level: "error",
      message: `Falló atender un mensaje entrante: ${
        err instanceof Error ? err.message : String(err)
      }`,
      payload: { igsid },
    });
  }
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
        /**
         * La misma comprobación en sha1, que Meta manda en paralelo.
         *
         * Si la sha1 cuadrase y la sha256 no, el fallo sería mío y no del
         * secreto. Cuesta una línea y evita otra ronda de "prueba otra vez".
         */
        sha1Calculada: process.env.META_APP_SECRET
          ? createHmac("sha1", process.env.META_APP_SECRET)
              .update(crudo)
              .digest("hex")
          : null,
        // Cuánto mide el secreto, no el secreto. Un valor mal pegado —el App ID
        // en vez de la clave, o con un salto de línea detrás— se ve aquí.
        largoDelSecreto: process.env.META_APP_SECRET?.length ?? 0,
        bytesDelCuerpo: Buffer.byteLength(crudo, "utf8"),
        caracteresDelCuerpo: crudo.length,
        /**
         * Todas las cabeceras de Meta, no solo la que espero.
         *
         * Meta manda además una firma sha1 en `x-hub-signature`, y hay
         * integraciones que solo reciben esa. Mirar únicamente la que doy por
         * buena es como no mirar: cada comprobación cuesta que una persona vaya
         * a un panel y pulse un botón, así que esta vez se recoge todo de una.
         */
        cabeceras: Object.fromEntries(
          [...request.headers.entries()].filter(
            ([k]) => k.startsWith("x-hub") || k === "content-type",
          ),
        ),
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

  /**
   * Un comentario nuevo se atiende AHORA.
   *
   * Es la razón de ser de todo esto: Meta avisa, y el recurso sale en segundos
   * en vez de esperar a que un cron pase a preguntar. Se lanza sin esperar
   * porque Meta reintenta lo que no conteste 200 deprisa, y un reintento
   * mientras aún estamos escribiendo sería el mismo DM dos veces.
   */
  const entradas = (payload as PayloadMeta)?.entry ?? [];

  /**
   * Los comentarios que hemos escrito nosotros no cuentan.
   *
   * Cuando el imán contesta en público —"¡Va por privado!"— ese comentario
   * vuelve por el webhook como un evento más, con `from.id` igual a la cuenta
   * que lo recibe. Sin descartarlo, cada respuesta nuestra relanza el ciclo
   * entero del imán: trabajo por duplicado y una llamada a Meta de regalo.
   */
  const conComentario = entradas.filter((e) =>
    (e.changes ?? []).some(
      (c) => c.field === "comments" && c.value?.from?.id !== e.id,
    ),
  );
  /**
   * `after` y no `void`.
   *
   * Lanzar el trabajo sin esperarlo parecía lo correcto —Meta reintenta lo que
   * tarda en contestar— pero en Vercel la función se congela en cuanto responde
   * y la tarea muere a medias: cada evento dejaba un "Failed query" y ningún
   * comentario atendido. `after` mantiene viva la invocación después de haber
   * respondido, que es exactamente lo que hace falta aquí.
   */
  for (const e of conComentario) after(atenderTodosLosImanes(e.id));

  /**
   * Un mensaje entrante es el momento de comprobar si esa persona te sigue.
   *
   * Antes no se puede: hasta que no te escribe, Meta responde "User consent is
   * required to access user profile". Su mensaje ES el consentimiento, así que
   * el embudo pide el follow por privado y comprueba cuando contestan.
   *
   * Los ecos —lo que escribimos nosotros— se descartan aquí: sin esto el imán
   * se contestaría a sí mismo en bucle.
   */
  for (const e of entradas) {
    for (const m of e.messaging ?? []) {
      const de = m.sender?.id;
      const texto = m.message?.text;
      /**
       * `is_echo` no es la única forma de reconocer lo nuestro.
       *
       * Meta lo marca casi siempre, pero cuando no lo hace el mensaje entra
       * como si lo hubiera escrito un desconocido y el imán se contesta a sí
       * mismo. Que el remitente sea la propia cuenta lo dice igual de claro y
       * no depende de que venga la marca.
       */
      if (!de || !texto || m.message?.is_echo || de === e.id) continue;
      // `e.id` es la cuenta que lo recibe: sin eso, con dos cuentas conectadas
      // el mensaje se podría atender desde la que no es.
      after(atenderMensajeEntrante(de, texto, e.id));
    }
  }

  // Meta reintenta lo que no conteste 200 rápido, así que se responde antes de
  // hacer nada más. Lo que haya que procesar se procesa desde lo guardado.
  return new NextResponse("", { status: 200 });
}
