import { NextResponse } from "next/server";
import { and, count, desc, eq, gte, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  TERMINAL_LEAD_STATUSES,
  accounts,
  campaigns,
  leads,
  runLogs,
  touches,
} from "@/lib/db/schema";
import { fechaIso, jsonError, parseBody, serverError } from "@/lib/api";
import {
  ErrorAntesDeEnviar,
  UnipileError,
  enviarCorreo,
  enviarEnConversacion,
  iniciarChat,
  identificadorDeUrlLinkedin,
  invitar,
  notaDeInvitacion,
  obtenerUsuario,
} from "@/lib/unipile";
import { mensajeDirecto } from "@/lib/instagram";
import { tokenDeCuenta } from "@/lib/instagram-cuenta";
import { ajustesEfectivos } from "@/lib/workspace";
import { AVISO_SIN_PRECIOS, mencionaDinero } from "@/lib/sin-precios";

export const dynamic = "force-dynamic";
export const maxDuration = 60;


/** Fallos de envío seguidos antes de apartar un lead como irrecuperable. */
const MAX_FALLOS_POR_LEAD = 3;

/**
 * Errores de Unipile que hablan de ESTE destinatario y no de nuestro sistema.
 *
 * Un perfil bloqueado o borrado no se arregla esperando hora y media, así que
 * reintentarlo tres veces son tres fallos garantizados y tres huecos del cupo
 * del día tirados. Estos van directos a 'error'.
 *
 * Deliberadamente NO está aquí `provider_error`, que es un 500. Cuando El Sofá
 * del Empresario mandaba a Unipile un identificador de Google Maps, la
 * respuesta era exactamente esa, treinta y cuatro veces seguidas: un fallo
 * nuestro disfrazado de destinatario imposible. Si llega a estar en la lista,
 * habría quemado treinta y cuatro leads buenos por un bug de una línea.
 */
export const DESTINATARIO_IMPOSIBLE = ["invalid_recipient", "user_unreachable"];

/**
 * LinkedIn ha frenado la cuenta entera.
 *
 * El nombre del error engaña: `cannot_resend_yet` suena a "esa persona ya tiene
 * tu invitación", y así se leía. El detalle real es otro —"You have reached a
 * temporary provider limit"— y habla de la CUENTA, no del destinatario.
 *
 * La diferencia costó 62 prospectos: se marcaban como contactados sin haber
 * recibido nada, salían de la cola para siempre y el siguiente lead del lote
 * chocaba contra la misma pared. En toda la historia de la campaña llegaron a
 * salir tres invitaciones.
 *
 * Lo correcto es lo contrario de lo que hacía: el lead vuelve a la cola intacto
 * y quien se aparta es la cuenta, hasta que el proveedor la suelte.
 */
export const CUENTA_FRENADA = "cannot_resend_yet";

/**
 * Esta persona YA tiene nuestra invitación.
 *
 * Se parece a `cannot_resend_yet` y no es lo mismo, y la diferencia es todo:
 * aquel habla de la cuenta —"has llegado a un tope temporal"— y este del
 * destinatario, con estas palabras: "An invitation has already been sent
 * recently to this recipient".
 *
 * Aquí sí toca sacarlo de la cola. No es un fallo: ese prospecto tiene nuestro
 * mensaje esperando en sus invitaciones, y volver a intentarlo es pedirle a
 * LinkedIn invitar dos veces a la misma persona, que es justo el patrón por el
 * que restringen cuentas.
 */
export const YA_TIENE_LA_INVITACION = "already_invited_recently";

/**
 * Cuánto se aparta una cuenta frenada.
 *
 * Los topes de LinkedIn se cuentan por semana, pero se sueltan poco a poco: no
 * hace falta esperar siete días, sí evitar volver dentro de un rato. Doce horas
 * hacen que un freno de la mañana no se coma también la tarde, y que uno de la
 * tarde deje la mañana siguiente libre.
 */
export const HORAS_DE_FRENO = 12;

/** El `type` de la respuesta de Unipile, si el error viene de ahí. */
export function tipoDeErrorUnipile(err: unknown): string | null {
  if (!(err instanceof UnipileError)) return null;
  const m = err.body.match(/errors\/([a-z_]+)/);
  return m?.[1] ?? null;
}

const cuerpo = z.object({
  leadId: z.string().uuid(),
  texto: z.string().min(1),
  step: z.number().int().positive().default(1),
  /** 'invitacion' = petición de contacto de LinkedIn; 'mensaje' = DM o email. */
  tipo: z.enum(["invitacion", "mensaje"]).default("mensaje"),
  /** Hilo existente. Si no viene, se abre uno nuevo. */
  chatId: z.string().optional(),
  /**
   * Asunto del correo. Solo se usa en campañas de email; los mensajes de
   * LinkedIn e Instagram no llevan.
   */
  asunto: z.string().max(200).optional(),
  /** Cuándo toca el siguiente toque, si procede. */
  nextActionAt: fechaIso().optional(),
  /** Estado al que pasa el lead después de enviar. */
  nuevoEstado: z
    .enum([
      "contactado",
      "en_seguimiento",
      "respondido",
      "cualificando",
      "cualificado",
    ])
    .optional(),
});

/**
 * El hilo que ya exista con este lead, si lo hay.
 *
 * El `chat_id` llega en la petición cuando quien escribe es el flujo de
 * entrantes, que lo tiene a mano. Los demás flujos no lo pasan, así que hay que
 * ir a buscarlo: el toque entrante lo guardó al registrarlo.
 */
async function hiloConocido(leadId: string): Promise<string | null> {
  const [previo] = await db
    .select({ chat: touches.unipileChatId })
    .from(touches)
    .where(and(eq(touches.leadId, leadId), isNotNull(touches.unipileChatId)))
    .orderBy(desc(touches.createdAt))
    .limit(1);
  return previo?.chat ?? null;
}

/**
 * Enviar un mensaje. Es el único camino por el que sale texto hacia una persona.
 *
 * El orden es la restricción no negociable del sistema y está aquí, no en n8n:
 *
 *   1. Se REGISTRA el toque como borrador. Si esto falla, no se envía nada.
 *   2. Se envía por Unipile.
 *   3. Se CONFIRMA el toque con su id de mensaje y su fecha.
 *
 * Si el paso 2 falla, el toque queda en 'fallido' y NO se reintenta desde aquí:
 * el envío pudo salir y haber fallado solo la respuesta, y reintentar duplicaría
 * el mensaje al prospecto. Lo mira una persona.
 *
 * Con el autopiloto apagado se hace el paso 1 y se para: queda el borrador en el
 * hilo del lead, visible en el dashboard, y no sale nada.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo);
  if (!body.ok) return body.response;
  const d = body.data;

  // El filtro y su porqué viven en lib/sin-precios.ts: hay dos puertas de
  // salida hacia una persona y no pueden endurecerse por separado.
  if (mencionaDinero(d.texto)) {
    await db.insert(runLogs).values({
      workflow: "sdr-envio",
      level: "warn",
      message: "Mensaje bloqueado: mencionaba dinero.",
      // El leadId va en el payload y no en la columna: si el lead no existiera,
      // la clave ajena convertiría el bloqueo en un 500.
      payload: { leadId: d.leadId, texto: d.texto },
    });
    return jsonError(AVISO_SIN_PRECIOS, 422);
  }

  try {
    const [fila] = await db
      .select({ lead: leads, campana: campaigns, cuenta: accounts })
      .from(leads)
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .leftJoin(accounts, eq(campaigns.accountId, accounts.id))
      .where(eq(leads.id, d.leadId));

    if (!fila) return jsonError("Ese lead no existe.", 404);
    const { lead, campana, cuenta } = fila;

    /**
     * Un estado terminal significa exactamente "no se le vuelve a escribir".
     *
     * Antes esto solo miraba 'revision_humana' y dejaba pasar los otros cuatro.
     * El grave es `no_interesado`: es el estado en el que aterriza quien ha
     * pedido que le dejen en paz (la herramienta `descartar` con motivo "baja
     * solicitada"), así que insistir dos veces bastaba para volver a escribirle.
     * La lista sale del esquema para que añadir un estado terminal nuevo lo
     * cubra sin tocar esto.
     */
    if ((TERMINAL_LEAD_STATUSES as readonly string[]).includes(lead.status)) {
      const motivo =
        lead.status === "revision_humana"
          ? "está en revisión humana"
          : lead.status === "no_interesado"
            ? "pidió que no se le escribiera más"
            : `está en "${lead.status}"`;
      return jsonError(`Ese lead ${motivo}. No se le puede escribir.`, 409);
    }
    if (!cuenta) return jsonError("La campaña no tiene cuenta de envío.", 409);
    if (cuenta.status !== "active") {
      return jsonError(`La cuenta está en "${cuenta.status}".`, 409);
    }

    /**
     * No se contesta dos veces al mismo mensaje.
     *
     * Cuando llegan dos entrantes casi a la vez —pasa con los autorespondedores
     * y con las cuentas que tienen su propio bot— cada uno dispara su propia
     * respuesta, y salían dos mensajes nuestros con dos segundos de diferencia.
     *
     * El primer intento de arreglarlo fue prohibir dos envíos en cinco minutos,
     * y estaba mal: bloqueó una respuesta buena a alguien que contestó rápido y
     * se quedó esperando cincuenta minutos. En una conversación viva, contestar
     * seguido no es un fallo: es la conversación.
     *
     * Lo que hay que impedir es otra cosa: mandar algo cuando su último mensaje
     * YA tiene respuesta. Eso ataja los dobles sin tocar un ida y vuelta real, y
     * no estorba a la prospección en frío ni al seguimiento, donde no hay
     * ningún entrante al que contestar.
     */
    const [ultimoEntrante] = await db
      .select({ cuando: touches.createdAt })
      .from(touches)
      .where(and(eq(touches.leadId, lead.id), eq(touches.direction, "in")))
      .orderBy(desc(touches.createdAt))
      .limit(1);

    if (ultimoEntrante) {
      const [yaContestado] = await db
        .select({ id: touches.id })
        .from(touches)
        .where(
          and(
            eq(touches.leadId, lead.id),
            eq(touches.direction, "out"),
            eq(touches.status, "enviado"),
            gte(touches.sentAt, ultimoEntrante.cuando),
          ),
        )
        .limit(1);

      if (yaContestado) {
        await db.insert(runLogs).values({
          workflow: "sdr-envio",
          leadId: lead.id,
          level: "info",
          message: "No se manda: su último mensaje ya tiene respuesta.",
          payload: { texto: d.texto.slice(0, 300) },
        });
        return jsonError(
          "Su último mensaje ya tiene respuesta. Espera a que vuelva a escribir.",
          429,
        );
      }
    }

    // El autopiloto es el de LA EMPRESA de esta campaña, no uno global. Con
    // varias empresas conectadas, una puede estar enviando mientras otra sigue
    // en borradores, que es justo lo que se pidió.
    const ajustes = await ajustesEfectivos(campana.workspaceId);

    // ---- 1. Registrar ANTES de enviar --------------------------------------
    const [toque] = await db
      .insert(touches)
      .values({
        leadId: lead.id,
        accountId: cuenta.id,
        channel: campana.channel,
        direction: "out",
        status: "borrador",
        body: d.texto,
        unipileChatId: d.chatId,
        step: d.step,
      })
      .returning({ id: touches.id });

    // ---- Autopiloto apagado: aquí se para ----------------------------------
    if (!ajustes.autopilot) {
      await db.insert(runLogs).values({
        workflow: "sdr-envio",
        leadId: lead.id,
        level: "info",
        message: `Borrador guardado. El autopiloto de ${ajustes.companyName} está apagado, no se ha enviado nada.`,
      });
      return NextResponse.json({
        enviado: false,
        motivo: "autopiloto_apagado",
        touchId: toque.id,
      });
    }

    // ---- 2. Enviar ----------------------------------------------------------
    try {
      let messageId: string;
      let chatId = d.chatId ?? null;

      if (campana.channel === "email") {
        // El correo va por su propio endpoint de Unipile, no por /chats.
        if (!lead.email) {
          throw new UnipileError(
            "El lead no tiene dirección de correo.",
            400,
            "",
          );
        }
        const r = await enviarCorreo({
          accountId: cuenta.unipileAccountId,
          destinatario: lead.email,
          // Un asunto corto y sin promesas: el playbook prohíbe sonar a anuncio,
          // y eso empieza por el asunto.
          asunto: d.asunto?.trim() || "Una pregunta rápida",
          cuerpo: d.texto,
        });
        messageId = r.message_id;
      } else if (campana.channel === "linkedin" && (chatId ??= await hiloConocido(lead.id))) {
        /**
         * Si ya hay hilo con esta persona, se responde EN EL HILO.
         *
         * Va antes que todo lo demás porque la pregunta "¿invito o escribo?" no
         * se contesta mirando el grado de conexión, se contesta mirando si ya
         * hay conversación. Alguien puede contestar a la nota de la invitación
         * sin aceptarla: sigue siendo de segundo grado y sin embargo ya te está
         * hablando.
         *
         * Ese caso acababa en `invitar`, y LinkedIn respondía
         * `already_invited_recently`. O sea: la respuesta se perdía justo con
         * quien había dado el paso de contestar, y el error decía que el
         * problema era la invitación cuando el problema era estar invitando.
         */
        const r = await enviarEnConversacion({
          accountId: cuenta.unipileAccountId,
          providerId: lead.providerId,
          chatId,
          texto: d.texto,
        });
        messageId = r.message_id;
        chatId = r.chat_id;
      } else if (campana.channel === "linkedin") {
        /**
         * En LinkedIn, en frío, se INVITA. No se manda un DM.
         *
         * LinkedIn solo deja escribir a contactos de primer grado; a los demás
         * responde 422 "no_connection_with_recipient", o exige Sales Navigator
         * con un 403 "subscription_required". Se intentaba mandar mensaje a
         * todos y fallaban ochenta y cuatro seguidos.
         *
         * Además el `provider_id` hay que resolverlo contra Unipile desde la URL
         * del perfil: el id que trae la base de datos B2B no es el suyo.
         */
        let providerId = lead.providerId;
        let primerGrado = false;

        const publico = identificadorDeUrlLinkedin(lead.linkedinUrl);
        if (publico) {
          const perfil = await obtenerUsuario(cuenta.unipileAccountId, publico);
          providerId = perfil.provider_id ?? perfil.id ?? providerId;
          primerGrado = perfil.network_distance === "DISTANCE_1";
          // Se guarda para no volver a resolverlo en cada toque.
          if (providerId && providerId !== lead.providerId) {
            await db
              .update(leads)
              .set({ providerId })
              .where(eq(leads.id, lead.id));
          }
        }

        if (!providerId) {
          throw new UnipileError(
            "No se pudo resolver el perfil de LinkedIn. Revisa la URL del lead.",
            400,
            "",
          );
        }

        if (primerGrado) {
          const r = await iniciarChat({
            accountId: cuenta.unipileAccountId,
            attendeeId: providerId,
            texto: d.texto,
          });
          messageId = r.message_id;
          chatId = r.chat_id;
        } else {
          // El recorte lo hace notaDeInvitacion, que corta por el final de una
          // frase y respeta el tope real de 200. Aquí había un slice a 300 —el
          // número que dice la documentación de LinkedIn, no el que acepta la
          // API— y `notaDeInvitacion` estaba importada sin usarse: diez
          // invitaciones de hoy murieron con "too_many_characters" o las paró
          // nuestra propia comprobación por tener 217, 244, 292 y 300 letras.
          const r = await invitar({
            accountId: cuenta.unipileAccountId,
            providerId,
            mensaje: notaDeInvitacion(d.texto),
            email: lead.email ?? undefined,
          });
          messageId = r.invitation_id;
        }
      } else if (d.tipo === "invitacion") {
        if (!lead.providerId) {
          throw new UnipileError(
            "El lead no tiene provider_id para invitarlo.",
            400,
            "",
          );
        }
        const r = await invitar({
          accountId: cuenta.unipileAccountId,
          providerId: lead.providerId,
          mensaje: notaDeInvitacion(d.texto),
          email: lead.email ?? undefined,
        });
        messageId = r.invitation_id;
      } else if (campana.channel === "instagram" && cuenta.metaToken) {
        /**
         * Esta rama va ANTES que la del chat guardado, y no es indiferente.
         *
         * `chatId` llega en la petición, y un lead de Instagram puede arrastrar
         * uno de cuando estas cuentas iban por Unipile. Si esa rama se mira
         * primero, el mensaje sale hacia una cuenta de Unipile que ya no está
         * conectada y la conversación se muere sin motivo visible. Con token de
         * Meta, Meta es el único camino que llega.
         */
        /**
         * Instagram por la API de Meta.
         *
         * Es el camino nuevo: Unipile ya no interviene. El destinatario es el
         * identificador con el que Meta llama a esa persona, que se guarda
         * cuando comenta o cuando escribe — y es el único que reconoce.
         *
         * Sin esta rama, el agente redactaba la respuesta y el envío se iba por
         * Unipile a una cuenta que ya no está conectada: la conversación se
         * moría justo después de entregar el recurso.
         */
        if (!lead.providerId) {
          throw new ErrorAntesDeEnviar(
            "Ese lead no tiene identificador de Instagram: no se sabe a quién escribir.",
          );
        }
        const viva = await tokenDeCuenta(cuenta.id);
        if (!viva) {
          throw new ErrorAntesDeEnviar(
            `La cuenta "${cuenta.displayName}" ya no está autorizada en Instagram.`,
          );
        }
        const r = await mensajeDirecto(
          viva.token,
          viva.igUserId,
          lead.providerId,
          d.texto,
        );
        messageId = r.message_id ?? "enviado";
      } else if (chatId) {
        // No basta con `enviarEnChat`: el chat_id guardado caduca en cuanto la
        // conversación existe de verdad, y entonces el segundo toque a esa
        // persona devolvía 404 y se daba por fallido.
        const r = await enviarEnConversacion({
          accountId: cuenta.unipileAccountId,
          providerId: lead.providerId,
          chatId,
          texto: d.texto,
        });
        messageId = r.message_id;
        chatId = r.chat_id;
      } else {
        /**
         * Instagram. El `provider_id` guardado NO sirve para abrir un chat.
         *
         * Los leads que salen de Google Maps traen ahí el identificador de
         * SITIO de Google —`ChIJ5eyG3VO5Z0AR8YGG0prk0nQ`—, no el de Instagram,
         * y Unipile responde 500 provider_error. La campaña de El Sofá del
         * Empresario se alimenta de Maps y llevaba treinta y cuatro envíos
         * seguidos fallando, cero entregados, mientras las otras dos cuentas de
         * Instagram —que sacan sus leads del scraper de Instagram— iban bien.
         *
         * Se resuelve como en LinkedIn: el id que tiene que reconocer Unipile
         * lo da Unipile, a partir del @usuario, que sí es correcto.
         */
        let attendeeId = lead.providerId;

        if (lead.instagramUsername) {
          const perfil = await obtenerUsuario(
            cuenta.unipileAccountId,
            lead.instagramUsername,
          );
          attendeeId = perfil.provider_id ?? perfil.id ?? attendeeId;
          // Se guarda para no volver a resolverlo en cada toque.
          if (attendeeId && attendeeId !== lead.providerId) {
            await db
              .update(leads)
              .set({ providerId: attendeeId })
              .where(eq(leads.id, lead.id));
          }
        }

        if (!attendeeId) {
          throw new UnipileError(
            "El lead no tiene ni @usuario de Instagram ni provider_id: no hay a quién escribir.",
            400,
            "",
          );
        }

        const r = await iniciarChat({
          accountId: cuenta.unipileAccountId,
          attendeeId,
          texto: d.texto,
        });
        messageId = r.message_id;
        chatId = r.chat_id;
      }

      // ---- 3. Confirmar -----------------------------------------------------
      const ahora = new Date();
      await db
        .update(touches)
        .set({
          status: "enviado",
          sentAt: ahora,
          unipileMessageId: messageId,
          unipileChatId: chatId,
        })
        .where(eq(touches.id, toque.id));

      await db
        .update(leads)
        .set({
          status:
            d.nuevoEstado ??
            (lead.status === "nuevo" ? "contactado" : lead.status),
          touchCount: lead.touchCount + 1,
          nextActionAt: d.nextActionAt
            ? new Date(d.nextActionAt)
            : lead.nextActionAt,
        })
        .where(eq(leads.id, lead.id));

      return NextResponse.json({
        enviado: true,
        touchId: toque.id,
        messageId,
        chatId,
      });
    } catch (err) {
      /**
       * Falló ANTES de salir: no se ha enviado nada.
       *
       * Es distinto de que Unipile rechace un envío. Aquí el mensaje no ha
       * llegado a la red, así que reintentar no puede duplicar nada: se borra
       * el borrador y el lead vuelve a la cola sin gastar uno de sus tres
       * intentos. `ErrorAntesDeEnviar` existía y se importaba aquí, pero no
       * había nada que lo distinguiera, así que una nota demasiado larga
       * quemaba al lead igual que un destinatario inexistente.
       */
      if (err instanceof ErrorAntesDeEnviar) {
        await db.delete(touches).where(eq(touches.id, toque.id));
        await db.insert(runLogs).values({
          workflow: "sdr-envio",
          leadId: lead.id,
          level: "warn",
          message: `No se llegó a enviar: ${err.message}`,
        });
        return jsonError(err.message, 422);
      }

      // El toque se queda en 'fallido'. Nadie reintenta ESE envío.
      await db
        .update(touches)
        .set({ status: "fallido" })
        .where(eq(touches.id, toque.id));

      /**
       * Pero el LEAD sí vuelve a la cola, y eso no puede ser indefinido.
       *
       * Al fallar no se toca el lead, así que sigue en 'nuevo' y a los noventa
       * minutos /api/leads/next lo entrega otra vez. Con un destinatario que no
       * va a funcionar nunca —un @usuario sacado de una web que ya no existe—
       * eso es un fallo cada hora y media, para siempre: veintisiete leads
       * llegaron a producir noventa fallos en una sola mañana.
       *
       * Al tercer intento pasa a 'error', que es terminal, sale de la cola y
       * aparece en el panel bajo "Con error" para que lo mire una persona.
       */
      const tipo = tipoDeErrorUnipile(err);

      if (tipo === YA_TIENE_LA_INVITACION) {
        /**
         * Ya está contactado de verdad: sale de la cola sin pasar por 'error'.
         * Y el toque se borra, porque el mensaje que cuenta ya se le mandó en
         * su momento; dejar un fallido aquí lo acercaría a un 'error' que no ha
         * merecido.
         */
        await db.delete(touches).where(eq(touches.id, toque.id));
        await db
          .update(leads)
          .set({
            status: lead.status === "nuevo" ? "contactado" : lead.status,
            nextActionAt: null,
          })
          .where(eq(leads.id, lead.id));
      } else if (tipo === CUENTA_FRENADA) {
        /**
         * El lead no ha hecho nada mal: se queda como estaba y vuelve a la cola
         * cuando la cuenta esté libre. Lo que se aparta es la cuenta, porque el
         * siguiente del lote fallaría exactamente igual.
         */
        const libre = new Date(Date.now() + HORAS_DE_FRENO * 3600_000);
        /**
         * Y el toque se borra en vez de quedarse en 'fallido'.
         *
         * No se envió nada: contarlo como fallo del lead lo acercaría al tercer
         * strike que lo manda a 'error' por algo que no ha hecho, y llenaría el
         * panel de fallos que no son de nadie. El motivo queda en el registro.
         */
        await db.delete(touches).where(eq(touches.id, toque.id));
        await db
          .update(leads)
          .set({ nextActionAt: libre })
          .where(eq(leads.id, lead.id));
        await db
          .update(accounts)
          .set({ throttledUntil: libre })
          .where(eq(accounts.id, cuenta.id));
      } else if (tipo && DESTINATARIO_IMPOSIBLE.includes(tipo)) {
        await db
          .update(leads)
          .set({ status: "error", nextActionAt: null })
          .where(eq(leads.id, lead.id));
      } else {
        const [{ n: fallosDelLead } = { n: 0 }] = await db
          .select({ n: count() })
          .from(touches)
          .where(
            and(eq(touches.leadId, lead.id), eq(touches.status, "fallido")),
          );

        if (Number(fallosDelLead) >= MAX_FALLOS_POR_LEAD) {
          await db
            .update(leads)
            .set({ status: "error", nextActionAt: null })
            .where(eq(leads.id, lead.id));
        }
      }
      await db.insert(runLogs).values({
        workflow: "sdr-envio",
        leadId: lead.id,
        level: "error",
        message: `Falló el envío: ${err instanceof Error ? err.message : String(err)}`,
        payload: { touchId: toque.id, noSeReintenta: true, tipo },
      });
      return jsonError(
        `El envío falló y NO se va a reintentar (podría duplicar el mensaje). Revísalo a mano. Detalle: ${err instanceof Error ? err.message : String(err)}`,
        502,
        { touchId: toque.id },
      );
    }
  } catch (err) {
    return serverError(err, "No se pudo enviar el mensaje");
  }
}
