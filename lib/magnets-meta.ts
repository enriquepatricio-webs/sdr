import { and, eq } from "drizzle-orm";
import { db } from "./db";
import {
  accounts,
  leadMagnets,
  leads,
  magnetContacts,
  runLogs,
} from "./db/schema";
import { desautorizar, tokenDeCuenta } from "./instagram-cuenta";
import {
  comentariosDeMedia,
  mediaDeUrl,
  mensajeDirecto,
  mensajePrivadoAlComentario,
  perfilDeQuienEscribe,
  responderComentario,
  sesionInvalidada,
} from "./instagram";
import {
  MAX_PETICIONES_DE_FOLLOW,
  RECORDATORIO_FOLLOW,
  RESPUESTA_PUBLICA,
  comentariosConLaClave,
  minutosHastaElNudge,
  pideQueLeDejen,
  promptDeEntrega,
} from "./magnets";
import { chat } from "./openrouter";
import { promptDeCampana } from "./playbook";
import { campanaDelImanId } from "./magnets-campana";
import { ajustesEfectivos } from "./workspace";
import { mencionaDinero } from "./sin-precios";

export type ResultadoEntrega = {
  ensayo: boolean;
  cuenta: string;
  comentariosLeidos: number;
  conLaClave: number;
  nuevos: number;
  hechos: Record<string, unknown>[];
  error?: string;
};

/**
 * Lee los comentarios de la publicación de un imán y entrega el recurso.
 *
 * Vive aquí y no en la ruta porque hay dos maneras de llegar: alguien que le da
 * al botón, y el webhook de Meta cuando entra un comentario nuevo. Con una
 * copia en cada sitio, mejorar el mensaje en uno dejaría el otro escribiendo
 * como antes — que es exactamente lo que pasó con los imanes de Unipile.
 */
export async function atenderComentarios(
  magnetId: string,
  opciones: { ensayo?: boolean; maximo?: number } = {},
): Promise<ResultadoEntrega> {
  const ensayo = opciones.ensayo ?? true;
  const maximo = opciones.maximo ?? 10;
  const vacio = {
    ensayo,
    cuenta: "",
    comentariosLeidos: 0,
    conLaClave: 0,
    nuevos: 0,
    hechos: [],
  };

  const [fila] = await db
    .select({ iman: leadMagnets, cuenta: accounts })
    .from(leadMagnets)
    .innerJoin(accounts, eq(accounts.id, leadMagnets.accountId))
    .where(eq(leadMagnets.id, magnetId));
  if (!fila) return { ...vacio, error: "Ese imán no existe." };

  const cuenta = await tokenDeCuenta(fila.cuenta.id);
  if (!cuenta) {
    return {
      ...vacio,
      error: `La cuenta "${fila.cuenta.displayName}" no está autorizada en Instagram.`,
    };
  }

  let mediaId: string | null;
  try {
    mediaId = await mediaDeUrl(cuenta.token, fila.iman.postUrl);
  } catch (err) {
    if (sesionInvalidada(err)) {
      await desautorizar(fila.cuenta.id, `Imán "${fila.iman.name}".`);
      return {
        ...vacio,
        error: `Instagram invalidó la sesión de @${cuenta.username}. Vuelve a autorizarla en /empresa.`,
      };
    }
    throw err;
  }
  if (!mediaId) {
    return {
      ...vacio,
      cuenta: `@${cuenta.username}`,
      error: `No encuentro esa publicación entre las de @${cuenta.username}.`,
    };
  }

  const crudos = await comentariosDeMedia(cuenta.token, mediaId);
  // El núcleo del embudo espera la forma que traía el scraper. Se traduce aquí,
  // en el borde, para no tener dos deduplicaciones distintas.
  const conClave = comentariosConLaClave(
    crudos.map((c) => ({
      id: c.id,
      text: c.text,
      ownerUsername: c.username ?? c.from?.username,
      owner: { full_name: c.username ?? c.from?.username },
    })),
    fila.iman.keyword,
  );

  // Los ya registrados no se vuelven a tocar: es lo que impide mandarle el
  // recurso dos veces a quien comenta dos veces.
  const yaEstan = new Set(
    (
      await db
        .select({ username: magnetContacts.username })
        .from(magnetContacts)
        .where(eq(magnetContacts.magnetId, fila.iman.id))
    ).map((c) => c.username),
  );
  const nuevos = conClave.filter(
    (c) => !yaEstan.has(c.username) && c.commentId,
  );
  const textoDe = new Map(crudos.map((c) => [c.id, c.text]));

  const ajustes = await ajustesEfectivos(fila.iman.workspaceId);
  const systemPrompt = await promptDeCampana(await campanaDelImanId(fila.iman));

  const idDe = new Map(crudos.map((c) => [c.id, c.from?.id]));

  const hechos: Record<string, unknown>[] = [];
  for (const c of nuevos.slice(0, maximo)) {
    /**
     * Al comentario se le pide el follow, no se le entrega el recurso.
     *
     * Comprobar si te sigue exige que esa persona te haya ESCRITO antes: hasta
     * entonces Meta responde 230 "User consent is required". Su respuesta a
     * este mensaje es lo que abre la puerta a poder comprobarlo.
     *
     * El texto es el que escribió la persona en el imán, sin tocarlo: es su
     * condición y no le corresponde reformularla a un modelo.
     */
    const texto = fila.iman.followMessage;

    const publico =
      RESPUESTA_PUBLICA[
        Math.floor(Date.now() / 1000) % RESPUESTA_PUBLICA.length
      ];

    if (ensayo) {
      hechos.push({
        usuario: c.username,
        comentario: textoDe.get(c.commentId!),
        publico,
        privado: texto,
      });
      continue;
    }

    const respuesta = await responderComentario(
      cuenta.token,
      c.commentId!,
      publico,
    );
    const dm = await mensajePrivadoAlComentario(
      cuenta.token,
      cuenta.igUserId,
      c.commentId!,
      texto,
    );

    await db.insert(magnetContacts).values({
      magnetId: fila.iman.id,
      username: c.username,
      fullName: c.fullName,
      commentId: c.commentId,
      // El id con el que Meta le llama al escribir. Es la única forma de casar
      // su respuesta con este contacto.
      providerId: idDe.get(c.commentId!) ?? null,
      state: "pidiendo_follow",
      followAsks: 1,
    });
    hechos.push({
      usuario: c.username,
      respuestaPublica: respuesta.id,
      mensajePrivado: dm.message_id ?? "enviado",
    });
  }

  if (!ensayo && hechos.length) {
    await db.insert(runLogs).values({
      workflow: "iman",
      level: "info",
      message: `Imán "${fila.iman.name}": ${hechos.length} comentarios atendidos.`,
      payload: { magnetId: fila.iman.id, mediaId },
    });
  }

  return {
    ensayo,
    cuenta: `@${cuenta.username ?? fila.cuenta.displayName}`,
    comentariosLeidos: crudos.length,
    conLaClave: conClave.length,
    nuevos: nuevos.length,
    hechos,
  };
}

/**
 * Le pasa el mensaje al agente de conversaciones, por el webhook de siempre.
 *
 * No espera respuesta: el agente tarda segundos en pensar y quien escribió está
 * mirando la pantalla, pero bloquear aquí solo conseguiría que Meta reintentara
 * el aviso y el mensaje entrara dos veces.
 */
async function pasarAlAgente(
  leadId: string | null,
  igsid: string,
  texto: string,
): Promise<void> {
  const webhook = process.env.N8N_INBOUND_WEBHOOK_URL;
  if (!webhook || !leadId) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "message_received",
        message_id: `ig-${igsid}-${Date.now()}`,
        message: texto,
        is_sender: false,
        sender: { attendee_provider_id: igsid },
        attendees: [],
        origen: "instagram-meta",
      }),
    });
  } catch {
    // Que no llegue al agente no puede tumbar la respuesta al webhook de Meta:
    // si tumbamos, Meta reintenta y el mensaje entra dos veces.
  }
}

/**
 * El lead de un contacto que ya tiene el recurso.
 *
 * Se crea al ENTREGAR y no al detectar el comentario: antes de eso no hay nada
 * que prospectar, solo alguien que ha pedido algo. Y el `provider_id` es el
 * identificador de Meta, que es con el que el envío sabrá escribirle.
 */
async function asegurarLeadDelIman(
  iman: typeof leadMagnets.$inferSelect,
  contacto: typeof magnetContacts.$inferSelect,
  igsid: string,
  datos: { username: string },
): Promise<string | null> {
  if (contacto.leadId) return contacto.leadId;
  const campaignId = await campanaDelImanId(iman);

  const [creado] = await db
    .insert(leads)
    .values({
      campaignId,
      fullName: contacto.fullName || datos.username,
      // De dónde salió: sin esto el agente le habla como a un desconocido al
      // que se escribe en frío, y se presenta a alguien que acaba de hablar
      // contigo hace un minuto.
      headline: `Pidió "${iman.keyword}" en un comentario y ya tiene el recurso`,
      instagramUsername: datos.username,
      providerId: igsid,
      status: "contactado",
      // El "¿qué tal?" no sale a los dos minutos: no le ha dado tiempo a nadie
      // a abrirlo. Entre 40 y 120 minutos es lo que tardaría una persona.
      nextActionAt: new Date(
        Date.now() + minutosHastaElNudge(contacto.id) * 60_000,
      ),
    })
    .onConflictDoNothing()
    .returning({ id: leads.id });
  if (creado) return creado.id;

  const [existente] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        eq(leads.campaignId, campaignId),
        eq(leads.instagramUsername, datos.username),
      ),
    );
  return existente?.id ?? null;
}

/**
 * Alguien contestó por privado a un imán: comprobar si sigue y actuar.
 *
 * Este es el momento en el que se puede preguntar si te sigue, y no antes:
 * hasta que esa persona no te escribe, Meta responde "User consent is
 * required". Por eso el embudo pide primero y comprueba después.
 */
export async function atenderMensaje(
  igsid: string,
  texto: string,
): Promise<{ atendido: boolean; que?: string; detalle?: string }> {
  const [fila] = await db
    .select({ contacto: magnetContacts, iman: leadMagnets, cuenta: accounts })
    .from(magnetContacts)
    .innerJoin(leadMagnets, eq(leadMagnets.id, magnetContacts.magnetId))
    .innerJoin(accounts, eq(accounts.id, leadMagnets.accountId))
    .where(eq(magnetContacts.providerId, igsid));
  if (!fila) return { atendido: false, que: "no es de ningún imán" };

  // Si pidió que le dejaran en paz, se para aquí y no recibe nada más.
  if (pideQueLeDejen(texto)) {
    await db
      .update(magnetContacts)
      .set({ state: "descartado" })
      .where(eq(magnetContacts.id, fila.contacto.id));
    return { atendido: true, que: "pidió que le dejaran en paz" };
  }

  if (fila.contacto.state !== "pidiendo_follow") {
    /**
     * Ya tiene el recurso: la conversación es del agente.
     *
     * Se le pasa por el mismo webhook de n8n que usan el correo y LinkedIn, en
     * vez de montarle aquí una segunda cañería. Un segundo camino hasta el
     * prospecto sería un segundo sitio donde olvidarse de comprobar si pidió la
     * baja, y esa comprobación no puede vivir en dos sitios.
     */
    await pasarAlAgente(fila.contacto.leadId, igsid, texto);
    return { atendido: true, que: "lo lleva el agente" };
  }

  const cuenta = await tokenDeCuenta(fila.cuenta.id);
  if (!cuenta) return { atendido: false, que: "la cuenta no está autorizada" };

  const perfil = await perfilDeQuienEscribe(cuenta.token, igsid);

  if (!perfil.is_user_follow_business) {
    /**
     * No sigue. Se le dice UNA vez y se para.
     *
     * A la segunda ya no es recordar, es insistir; y quedarse callado después
     * de que te escriban es lo que hace que parezca un bot roto.
     */
    if (fila.contacto.followAsks >= MAX_PETICIONES_DE_FOLLOW) {
      return { atendido: false, que: "ya se le recordó y sigue sin seguir" };
    }
    await mensajeDirecto(
      cuenta.token,
      cuenta.igUserId,
      igsid,
      RECORDATORIO_FOLLOW,
    );
    await db
      .update(magnetContacts)
      .set({ followAsks: fila.contacto.followAsks + 1 })
      .where(eq(magnetContacts.id, fila.contacto.id));
    return { atendido: true, que: "no sigue: se le ha recordado" };
  }

  // Sí sigue: se le entrega, y el mensaje lo escribe el agente.
  const ajustes = await ajustesEfectivos(fila.iman.workspaceId);
  const systemPrompt = await promptDeCampana(await campanaDelImanId(fila.iman));
  let mensaje = fila.iman.resource;
  try {
    const r = await chat({
      model: ajustes.openrouterModel,
      maxTokens: 400,
      temperature: 0.8,
      messages: [
        ...(systemPrompt
          ? [{ role: "system" as const, content: systemPrompt }]
          : []),
        {
          role: "user" as const,
          content: promptDeEntrega({
            nombre: perfil.username ?? fila.contacto.username,
            clave: fila.iman.keyword,
            recurso: fila.iman.resource,
            comentario: texto,
          }),
        },
      ],
    });
    mensaje = r.text.trim();
  } catch {
    // Sin modelo se manda el recurso a secas: es lo prometido, y eso no falla.
  }

  // El mismo filtro que el resto del sistema: ninguna cifra de dinero por chat.
  if (mencionaDinero(mensaje)) mensaje = fila.iman.resource;
  // Y el recurso tiene que ir sí o sí: es lo único que se ha prometido.
  if (!mensaje.includes(fila.iman.resource)) {
    mensaje = `${mensaje}\n\n${fila.iman.resource}`;
  }

  await mensajeDirecto(cuenta.token, cuenta.igUserId, igsid, mensaje);

  /**
   * A partir de aquí es un lead, no un contacto de un imán.
   *
   * El imán ha cumplido: pidió, comprobó y entregó. Lo que venga después —qué
   * tal le ha ido, si encaja, cerrar una reunión— es trabajo del agente, y el
   * agente solo sabe hablar de leads. Sin esta fila, la conversación se acaba
   * justo en el mejor momento: cuando esa persona acaba de recibir algo tuyo y
   * está mirando el móvil.
   */
  const leadId = await asegurarLeadDelIman(fila.iman, fila.contacto, igsid, {
    username: perfil.username ?? fila.contacto.username,
  });

  await db
    .update(magnetContacts)
    .set({
      state: "entregado",
      verifiedAt: new Date(),
      deliveredAt: new Date(),
      leadId,
    })
    .where(eq(magnetContacts.id, fila.contacto.id));

  await db.insert(runLogs).values({
    workflow: "iman",
    level: "info",
    message: `@${perfil.username ?? fila.contacto.username} sigue a la cuenta: recurso entregado.`,
    payload: { magnetId: fila.iman.id, contactId: fila.contacto.id },
  });

  return { atendido: true, que: "sigue: recurso entregado", detalle: mensaje };
}
