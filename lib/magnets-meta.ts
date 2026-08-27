import { and, eq } from "drizzle-orm";
import { db } from "./db";
import {
  accounts,
  campaigns,
  leadMagnets,
  leads,
  magnetContacts,
  runLogs,
  touches,
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
  PEDIR_FOLLOW_SIN_SABER,
  RESPUESTA_PUBLICA,
  SIN_MAS_RECORDATORIOS,
  comentariosConLaClave,
  faltaElRecurso,
  mencionaClave,
  minutosHastaElNudge,
  normalizarUsuario,
  pideQueLeDejen,
  promptDeEntrega,
} from "./magnets";
import { chat } from "./openrouter";
import { promptDeCampana } from "./playbook";
import {
  campanaDeConversaciones,
  campanaDelImanId,
} from "./magnets-campana";
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

/**
 * Atiende UN comentario: el único sitio donde se decide qué se le hace.
 *
 * Vive fuera del bucle porque hay DOS formas de llegar a un comentario y tienen
 * que acabar exactamente igual: releyendo la lista de la publicación, y el
 * aviso que Meta manda en el momento. Con una copia en cada sitio, mejorar una
 * dejaría la otra escribiendo como antes.
 */
async function atenderUnComentario(o: {
  iman: typeof leadMagnets.$inferSelect;
  cuentaId: string;
  token: string;
  igUserId: string;
  commentId: string;
  username: string;
  fullName: string | null;
  /** Quién lo escribió, según Meta. A veces no viene. */
  autorId: string | null;
  /** Lo que puso, si se conoce. */
  dijo: string | null;
  ensayo: boolean;
}): Promise<Record<string, unknown>> {
  const publico =
    RESPUESTA_PUBLICA[Math.floor(Date.now() / 1000) % RESPUESTA_PUBLICA.length];

  if (o.ensayo) {
    const sigue = o.autorId
      ? await perfilDeQuienEscribe(o.token, o.autorId)
          .then((p) => p.is_user_follow_business === true)
          .catch(() => null)
      : null;
    return {
      usuario: o.username,
      comentario: o.dijo,
      sigue,
      publico,
      privado:
        sigue === true
          ? "(el recurso, ya te sigue)"
          : sigue === false
            ? o.iman.followMessage
            : PEDIR_FOLLOW_SIN_SABER,
    };
  }

  /**
   * Se PIDE EL SITIO antes de escribir nada. Este orden es el arreglo.
   *
   * Al mismo comentario se llega por dos caminos —el aviso de Meta y la
   * relectura de la publicación— y salen del mismo webhook, a la vez. Cuando la
   * comprobación de "¿ya está atendido?" iba antes de escribir, los dos la
   * pasaban, los dos contestaban en público y solo entonces fallaba el segundo
   * al guardar. El resultado se veía en el post: la misma respuesta dos veces.
   *
   * El índice único por comentario es lo único que decide de verdad quién lo
   * atiende. Quien no consigue la fila se retira en silencio y no escribe.
   */
  const [contacto] = await db
    .insert(magnetContacts)
    .values({
      magnetId: o.iman.id,
      username: o.username,
      fullName: o.fullName,
      commentId: o.commentId,
      providerId: o.autorId,
      state: "pidiendo_follow",
      followAsks: 0,
    })
    .onConflictDoNothing()
    .returning();

  if (!contacto) return { usuario: o.username, yaAtendido: true };

  /**
   * Se intenta saber si ya te sigue, y muchas veces NO se puede.
   *
   * Meta responde 230 "User consent is required" cuando esa persona solo ha
   * comentado: el permiso para leer su perfil nace cuando te escribe. Por eso
   * hay tres respuestas y no dos, y "no se sabe" nunca se trata como "no te
   * sigue".
   */
  const sigue: boolean | null = o.autorId
    ? await perfilDeQuienEscribe(o.token, o.autorId)
        .then((p) => p.is_user_follow_business === true)
        .catch(() => null)
    : null;

  const respuesta = await responderComentario(o.token, o.commentId, publico);

  if (sigue === true) {
    await db
      .update(magnetContacts)
      .set({ state: "verificado", verifiedAt: new Date() })
      .where(eq(magnetContacts.id, contacto.id));

    const entrega = await entregarRecurso({
      iman: o.iman,
      cuentaId: o.cuentaId,
      token: o.token,
      igUserId: o.igUserId,
      contacto,
      igsid: o.autorId,
      username: o.username,
      dijo: o.dijo ?? o.iman.keyword,
      via: { comentario: o.commentId },
    });
    return {
      usuario: o.username,
      respuestaPublica: respuesta.id,
      sigue: true,
      entregado: entrega.mensaje.slice(0, 120),
    };
  }

  const dm = await mensajePrivadoAlComentario(
    o.token,
    o.igUserId,
    o.commentId,
    sigue === false ? o.iman.followMessage : PEDIR_FOLLOW_SIN_SABER,
  );
  await db
    .update(magnetContacts)
    .set({ followAsks: 1 })
    .where(eq(magnetContacts.id, contacto.id));

  return {
    usuario: o.username,
    respuestaPublica: respuesta.id,
    sigue,
    mensajePrivado: dm.message_id ?? "enviado",
  };
}

export async function atenderComentarioDelAviso(
  igUserId: string,
  aviso: {
    id?: string;
    text?: string;
    from?: { id?: string; username?: string };
    media?: { id?: string; original_media_id?: string };
  },
): Promise<{ atendido: boolean; que: string; detalle?: unknown }> {
  const commentId = aviso.id;
  const texto = aviso.text ?? "";
  if (!commentId || !texto) return { atendido: false, que: "aviso sin comentario" };

  // Lo que escribimos nosotros vuelve por el webhook: no se atiende.
  if (aviso.from?.id && aviso.from.id === igUserId) {
    return { atendido: false, que: "es nuestra propia respuesta" };
  }

  const [cuentaFila] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.igUserId, igUserId));
  if (!cuentaFila) return { atendido: false, que: "cuenta desconocida" };

  const imanes = await db
    .select()
    .from(leadMagnets)
    .where(
      and(eq(leadMagnets.accountId, cuentaFila.id), eq(leadMagnets.active, true)),
    );
  const candidatos = imanes.filter((m) => mencionaClave(texto, m.keyword));
  if (!candidatos.length) return { atendido: false, que: "no dice ninguna palabra" };

  const cuenta = await tokenDeCuenta(cuentaFila.id);
  if (!cuenta) return { atendido: false, que: "la cuenta no está autorizada" };

  /**
   * De qué publicación es. `original_media_id` es la del reel cuando el
   * comentario viene de un anuncio; `id` a secas cuando es orgánico.
   */
  const medioDelAviso = aviso.media?.original_media_id ?? aviso.media?.id ?? null;

  for (const iman of candidatos) {
    if (medioDelAviso) {
      const suyo = await mediaDeUrl(cuenta.token, iman.postUrl).catch(() => null);
      if (suyo && suyo !== medioDelAviso) continue;
    }

    /**
     * El índice único por comentario es quien decide de verdad si ya se
     * atendió: el aviso y la relectura pueden llegar a la vez, y sin esto la
     * misma persona recibiría el mensaje dos veces.
     */
    const [yaEsta] = await db
      .select({ id: magnetContacts.id })
      .from(magnetContacts)
      .where(eq(magnetContacts.commentId, commentId));
    if (yaEsta) return { atendido: false, que: "ya estaba atendido" };

    const hecho = await atenderUnComentario({
      iman,
      cuentaId: cuentaFila.id,
      token: cuenta.token,
      igUserId: cuenta.igUserId,
      commentId,
      username: normalizarUsuario(aviso.from?.username ?? commentId),
      fullName: aviso.from?.username ?? null,
      autorId: aviso.from?.id ?? null,
      dijo: texto,
      ensayo: false,
    });

    await db.insert(runLogs).values({
      workflow: "iman",
      level: "info",
      message: `Comentario atendido al vuelo en "${iman.name}"${
        aviso.media?.original_media_id ? " (llegó desde un anuncio)" : ""
      }.`,
      payload: { commentId, ...hecho },
    });
    return { atendido: true, que: "atendido desde el aviso", detalle: hecho };
  }

  return { atendido: false, que: "el comentario no es de ninguna publicación con imán" };
}

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
    hechos.push(
      await atenderUnComentario({
        iman: fila.iman,
        cuentaId: fila.cuenta.id,
        token: cuenta.token,
        igUserId: cuenta.igUserId,
        commentId: c.commentId!,
        username: c.username,
        fullName: c.fullName,
        autorId: idDe.get(c.commentId!) ?? null,
        dijo: textoDe.get(c.commentId!) ?? null,
        ensayo,
      }),
    );
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
): Promise<boolean> {
  const webhook = process.env.N8N_INBOUND_WEBHOOK_URL;
  if (!webhook || !leadId) return false;
  try {
    const res = await fetch(webhook, {
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

    /**
     * Mirar el código de respuesta, no solo que la petición no reventara.
     *
     * Esto devolvía `true` con cualquier respuesta, incluido un 404. Y n8n da
     * 404 cuando la URL configurada es la de PRUEBA —`/webhook-test/`— que solo
     * vale para una llamada justo después de pulsar "Execute workflow" en el
     * canvas. Con esa URL puesta, cada persona que contestaba se quedaba sin
     * respuesta mientras el registro decía "lo lleva el agente".
     *
     * Estuvo así un día entero. El fallo no fue la URL: fue dar por bueno un
     * 404.
     */
    if (!res.ok) {
      await db.insert(runLogs).values({
        workflow: "iman",
        level: "error",
        message: `El agente no recogió el mensaje: n8n respondió ${res.status}. Revisa N8N_INBOUND_WEBHOOK_URL.`,
        payload: { igsid, estado: res.status },
      });
      return false;
    }
    return true;
  } catch {
    /**
     * Que no llegue al agente no puede tumbar la respuesta al webhook de Meta:
     * si tumbamos, Meta reintenta y el mensaje entra dos veces.
     *
     * Pero sí se dice que no llegó. Devolver "atendido" sin haber atendido a
     * nadie deja una conversación muerta y un registro que jura que todo fue
     * bien, que es la peor combinación posible para averiguar qué pasó.
     */
    return false;
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
/** Una ficha de imán con su imán y su cuenta, que es como se lee siempre. */
type Fila = {
  contacto: typeof magnetContacts.$inferSelect;
  iman: typeof leadMagnets.$inferSelect;
  cuenta: typeof accounts.$inferSelect;
};

/**
 * Alguien pide la palabra por privado, sin haber comentado nunca.
 *
 * Es la otra puerta del imán y tiene que llevar al mismo sitio. Mucha gente ve
 * "comenta SISTEMA" y escribe SISTEMA por mensaje directo: es lo natural si ya
 * te sigue. Eso caía en "no es de ningún imán" y se quedaba sin respuesta, que
 * es la peor manera de recibir a alguien que te está pidiendo algo.
 *
 * Esta función SOLO le abre la ficha. Quién comprueba el follow y quién entrega
 * es el flujo de siempre, unas líneas más abajo: duplicar aquí esa decisión
 * sería tener dos sitios donde arreglar el mismo fallo, y el segundo siempre se
 * queda sin arreglar.
 */
async function fichaPorPalabraEnMensaje(
  igsid: string,
  texto: string,
  igUserId: string,
): Promise<Fila | null> {
  const [cuentaFila] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.igUserId, igUserId));
  if (!cuentaFila) return null;

  const imanes = await db
    .select()
    .from(leadMagnets)
    .where(
      and(
        eq(leadMagnets.accountId, cuentaFila.id),
        eq(leadMagnets.active, true),
      ),
    );
  const iman = imanes.find((m) => mencionaClave(texto, m.keyword));
  if (!iman) return null;

  const cuenta = await tokenDeCuenta(cuentaFila.id);
  if (!cuenta) return null;

  /**
   * El nombre de usuario, y si no se puede leer, el identificador.
   *
   * La ficha se guarda por (imán, usuario), así que necesita una clave estable.
   * Si Meta no contesta ahora mismo, el identificador sirve igual de bien y la
   * persona recibe respuesta; quedarse sin ficha por no saber cómo se llama
   * sería dejarla en silencio por un detalle cosmético.
   */
  const perfil = await perfilDeQuienEscribe(cuenta.token, igsid).catch(
    () => null,
  );
  const username = normalizarUsuario(perfil?.username ?? igsid);

  /**
   * Se abre en "pidiendo_follow" aunque ya nos siga.
   *
   * No es un descuido: es el estado desde el que el flujo de abajo comprueba el
   * follow y entrega. Abrirla ya verificada la mandaría directa al agente sin
   * haberle dado nunca el recurso, que es justo lo que vino a buscar.
   */
  await db
    .insert(magnetContacts)
    .values({
      magnetId: iman.id,
      username,
      fullName: perfil?.name ?? null,
      providerId: igsid,
      state: "pidiendo_follow",
      followAsks: 0,
    })
    .onConflictDoNothing();

  /**
   * Se relee en vez de usar lo devuelto por el INSERT.
   *
   * Si la ficha ya existía —un comentario suyo llegando casi a la vez, o una
   * conversación anterior— el INSERT no devuelve nada, y devolver null aquí
   * dejaría a esa persona sin respuesta. Releer da la fila en los dos casos.
   */
  const [fila] = await db
    .select({ contacto: magnetContacts, iman: leadMagnets, cuenta: accounts })
    .from(magnetContacts)
    .innerJoin(leadMagnets, eq(leadMagnets.id, magnetContacts.magnetId))
    .innerJoin(accounts, eq(accounts.id, leadMagnets.accountId))
    .where(
      and(
        eq(magnetContacts.magnetId, iman.id),
        eq(magnetContacts.username, username),
      ),
    );
  return fila ?? null;
}

/**
 * Contesta a alguien que ya era lead nuestro aunque no venga de ningún imán.
 *
 * Devuelve null si no se le reconoce; entonces sigue el camino de siempre.
 */
async function atenderLeadConocido(
  igsid: string,
  texto: string,
  igUserId: string,
): Promise<{ atendido: boolean; que: string; detalle?: string } | null> {
  const [cuentaFila] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.igUserId, igUserId));
  if (!cuentaFila?.workspaceId) return null;

  const cuenta = await tokenDeCuenta(cuentaFila.id);
  if (!cuenta) return null;

  const perfil = await perfilDeQuienEscribe(cuenta.token, igsid).catch(
    () => null,
  );
  if (!perfil?.username) return null;
  const usuario = normalizarUsuario(perfil.username);

  const [fila] = await db
    .select({ lead: leads, campana: campaigns, cuentaDelLead: accounts })
    .from(leads)
    .innerJoin(campaigns, eq(campaigns.id, leads.campaignId))
    .leftJoin(accounts, eq(accounts.id, campaigns.accountId))
    .where(eq(leads.instagramUsername, usuario));
  if (!fila) return null;

  /**
   * Si la cuenta de su campaña ya no puede enviar, la conversación se muda a
   * la cuenta donde está escribiendo. No es un capricho: el envío saca la
   * cuenta de la campaña, así que dejarlo donde está es garantizar que la
   * respuesta no salga.
   */
  const puedeEnviarDesdeSuCampana =
    fila.cuentaDelLead?.id === cuentaFila.id ||
    (fila.cuentaDelLead?.status === "active" &&
      Boolean(fila.cuentaDelLead?.metaToken));

  if (!puedeEnviarDesdeSuCampana) {
    const campaignId = await campanaDeConversaciones({
      cuentaId: cuentaFila.id,
      workspaceId: cuentaFila.workspaceId,
      usuario: cuenta.username ?? cuentaFila.displayName,
    });
    await db
      .update(leads)
      .set({ campaignId })
      .where(eq(leads.id, fila.lead.id));
  }

  // El identificador de Meta, para que la próxima vez case sin preguntar.
  await db
    .update(leads)
    .set({ providerId: igsid })
    .where(eq(leads.id, fila.lead.id));

  const entregado = await pasarAlAgente(fila.lead.id, igsid, texto);
  await db.insert(runLogs).values({
    workflow: "iman",
    level: entregado ? "info" : "error",
    message: entregado
      ? `@${usuario} no es de ningún imán pero ya era lead: lo lleva el agente.`
      : `@${usuario} ya era lead y el agente no recogió su mensaje.`,
    payload: { igsid, leadId: fila.lead.id, movido: !puedeEnviarDesdeSuCampana },
  });

  return entregado
    ? { atendido: true, que: "ya era lead: lo lleva el agente" }
    : { atendido: false, que: "ya era lead, pero el agente no lo recogió" };
}

export async function atenderMensaje(
  igsid: string,
  texto: string,
  /**
   * La cuenta de Instagram a la que ha escrito, si el webhook la dice.
   *
   * Meta numera a las personas por cuenta de negocio, así que en teoría el
   * mismo identificador no aparece en dos. En teoría: si alguna vez ocurre, sin
   * este filtro se cogería la primera fila que salga y se contestaría con el
   * token de otra cuenta, a alguien que nunca escribió allí. Cuesta una
   * condición y cierra la puerta.
   */
  igUserId?: string,
): Promise<{ atendido: boolean; que?: string; detalle?: string }> {
  const buscar = (condicion: ReturnType<typeof eq>) =>
    db
      .select({ contacto: magnetContacts, iman: leadMagnets, cuenta: accounts })
      .from(magnetContacts)
      .innerJoin(leadMagnets, eq(leadMagnets.id, magnetContacts.magnetId))
      .innerJoin(accounts, eq(accounts.id, leadMagnets.accountId))
      .where(condicion);

  /**
   * Lo PRIMERO: ¿está diciendo la palabra de algún imán?
   *
   * Va antes que la búsqueda por identificador y no después, y la diferencia
   * importa cuando una cuenta tiene dos imanes. Quien ya recibió el primero
   * tiene ficha, así que la búsqueda por identificador la encontraba, veía que
   * ya estaba entregada y mandaba la conversación al agente: pedía el segundo
   * recurso y le contestaba un comercial. Preguntando primero por la palabra,
   * cada mensaje se resuelve contra el imán que esa persona está nombrando.
   *
   * Si no nombra ninguno, no hace nada y siguen las búsquedas de siempre.
   */
  let fila: Fila | undefined;
  if (igUserId && !pideQueLeDejen(texto)) {
    fila =
      (await fichaPorPalabraEnMensaje(igsid, texto, igUserId)) ?? undefined;
  }

  /**
   * Primero acotando por la cuenta, y si no sale, sin acotar.
   *
   * El filtro por cuenta es lo correcto, pero depende de que el identificador
   * guardado sea el mismo que manda Meta, y Meta usa dos distintos para la
   * misma cuenta. Si el guardado es el otro —cuentas autorizadas antes de que
   * esto se supiera— la consulta acotada no devuelve nada.
   *
   * Rendirse ahí sería dejar de contestar sin decir por qué: exactamente el
   * fallo que más caro sale, porque desde fuera se ve igual que estar apagado.
   * Así que se reintenta sin el filtro y el sistema sigue funcionando mientras
   * el identificador se corrige solo en la siguiente autorización.
   */
  if (!fila)
    [fila] = igUserId
      ? await buscar(
          and(
            eq(magnetContacts.providerId, igsid),
            eq(accounts.igUserId, igUserId),
          )!,
        )
      : [];
  if (!fila) [fila] = await buscar(eq(magnetContacts.providerId, igsid));

  /**
   * Y si aún no sale, se le pregunta a Meta quién es y se busca por su nombre.
   *
   * De un comentario ajeno Meta no siempre devuelve el `from.id`: lo hace con
   * cuentas de negocio y con las que tienen un papel en la app, y lo omite con
   * las demás. El mensaje privado sí les llega igual, porque va anclado al
   * comentario y no necesita saber su identificador — pero el contacto se
   * guarda sin él.
   *
   * Eso significa que la única persona de fuera que ha usado el imán entraría
   * en la conversación y no la reconoceríamos: escribe, y silencio. Justo lo
   * que no puede pasar. Cuando escribe SÍ se puede leer su perfil, así que se
   * la encuentra por su nombre de usuario y se le graba el identificador, que
   * a partir de ahí ya no vuelve a hacer falta.
   */
  if (!fila && igUserId) {
    const [dueña] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.igUserId, igUserId));
    const viva = dueña ? await tokenDeCuenta(dueña.id) : null;
    if (viva) {
      const quien = await perfilDeQuienEscribe(viva.token, igsid).catch(
        () => null,
      );
      if (quien?.username) {
        [fila] = await buscar(
          and(
            eq(magnetContacts.username, normalizarUsuario(quien.username)),
            eq(accounts.id, dueña!.id),
          )!,
        );
        if (fila) {
          await db
            .update(magnetContacts)
            .set({ providerId: igsid })
            .where(eq(magnetContacts.id, fila.contacto.id));
        }
      }
    }
  }

  /**
   * No es de ningún imán, pero puede ser un lead que ya conocemos.
   *
   * A un prospecto se le escribió en frío desde una cuenta y meses después
   * contesta a OTRA: la que ve en un anuncio, o la que le sale al buscar la
   * marca. Su lead sigue colgando de la campaña vieja, y esta vía solo miraba
   * contactos de imán, así que se quedaba sin respuesta.
   *
   * Se le reconoce por su nombre de usuario, se le graba el identificador de
   * Meta para que la próxima vez case directo, y se mueve la conversación a la
   * cuenta donde de verdad está ocurriendo — si la de origen ya no puede
   * enviar, contestarle desde ella es imposible.
   */
  if (!fila && igUserId && !pideQueLeDejen(texto)) {
    const atendido = await atenderLeadConocido(igsid, texto, igUserId);
    if (atendido) return atendido;
  }

  if (!fila) {
    /**
     * Nadie sabe quién es, pero escribió a una cuenta con un imán encendido.
     *
     * No se le contesta automáticamente: a estas cuentas les escribe todo el
     * mundo y responder a cualquier cosa es peor que no responder. Pero sí
     * queda anotado, porque con una publicación viva esto suele ser alguien que
     * vio el vídeo y escribió a su manera —"me interesa", "cómo lo consigo"— y
     * esa persona merece que alguien la lea. Sin esta línea, no existía.
     */
    if (igUserId) {
      const conIman = await db
        .select({ id: leadMagnets.id })
        .from(leadMagnets)
        .innerJoin(accounts, eq(accounts.id, leadMagnets.accountId))
        .where(
          and(eq(accounts.igUserId, igUserId), eq(leadMagnets.active, true)),
        );
      if (conIman.length) {
        await db.insert(runLogs).values({
          workflow: "iman",
          level: "info",
          message: "Alguien escribió al privado sin decir la palabra del imán.",
          payload: { igsid, texto: texto.slice(0, 300) },
        });
      }
    }
    return { atendido: false, que: "no es de ningún imán" };
  }

  /**
   * Si alguna vez pidió que le dejaran en paz, no se le vuelve a escribir.
   *
   * Aunque ahora diga la palabra del imán. Podría argumentarse que pedir el
   * recurso ES consentir, pero esa decisión no la puede tomar un automatismo:
   * una baja que se levanta sola no es una baja. Queda anotado para que una
   * persona lo mire y conteste a mano si procede.
   */
  if (fila.contacto.state === "descartado") {
    await db.insert(runLogs).values({
      workflow: "iman",
      level: "info",
      message: `@${fila.contacto.username} había pedido que le dejaran en paz y ha vuelto a escribir. No se le contesta automáticamente.`,
      payload: { igsid, texto: texto.slice(0, 300) },
    });
    return { atendido: false, que: "pidió la baja en su momento" };
  }

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
     *
     * El lead se crea aquí si no lo tiene. Los contactos entregados antes de
     * que el embudo creara leads —y cualquiera al que Meta no le diera
     * identificador en su momento— se quedaron sin él, y sin lead el agente no
     * tiene a quién contestar: la persona escribía y no pasaba nada.
     */
    const leadId =
      fila.contacto.leadId ??
      (await asegurarLeadDelIman(fila.iman, fila.contacto, igsid, {
        username: fila.contacto.username,
      }));
    if (leadId && leadId !== fila.contacto.leadId) {
      await db
        .update(magnetContacts)
        .set({ leadId })
        .where(eq(magnetContacts.id, fila.contacto.id));
    }
    const entregado = await pasarAlAgente(leadId, igsid, texto);
    return entregado
      ? { atendido: true, que: "lo lleva el agente" }
      : {
          atendido: false,
          que: "no se pudo pasar al agente",
          detalle: leadId
            ? "el webhook de n8n no contestó"
            : "no se pudo crear el lead",
        };
  }

  const cuenta = await tokenDeCuenta(fila.cuenta.id);
  if (!cuenta) return { atendido: false, que: "la cuenta no está autorizada" };

  /**
   * Si Meta no contesta, no se entrega, pero tampoco se afirma que no sigue.
   *
   * Esta llamada podía reventar y llevarse por delante toda la respuesta: la
   * persona escribía y no recibía nada. Ahora un error no tumba nada — pero
   * tampoco se convierte en "no me sigues", porque decírselo a alguien que sí
   * te sigue es el error que más rápido delata que no hay nadie detrás.
   */
  const perfil = (await perfilDeQuienEscribe(cuenta.token, igsid).catch(
    async (err) => {
      await db.insert(runLogs).values({
        workflow: "iman",
        level: "warn",
        message: `No se pudo comprobar si @${fila.contacto.username} sigue a la cuenta.`,
        payload: {
          igsid,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return null;
    },
  ))!;

  if (perfil?.is_user_follow_business !== true) {
    // Se sabe que no sigue, o no se ha podido saber. No es lo mismo y no se le
    // dice lo mismo: solo se afirma lo que consta.
    const seSabe = perfil !== null;
    /**
     * No sigue. Se le dice UNA vez y se para.
     *
     * A la segunda ya no es recordar, es insistir; y quedarse callado después
     * de que te escriban es lo que hace que parezca un bot roto.
     */
    if (fila.contacto.followAsks >= MAX_PETICIONES_DE_FOLLOW) {
      /**
       * Se deja de PEDIR, no de responder. Quien escribe merece respuesta
       * aunque ya no haya nada nuevo que pedirle.
       *
       * Y aquí tampoco se afirma nada: "sigo sin verte por ahí" es una
       * afirmación sobre algo que puede no constar, igual que el recordatorio.
       */
      await mensajeDirecto(
        cuenta.token,
        cuenta.igUserId,
        igsid,
        seSabe ? SIN_MAS_RECORDATORIOS : PEDIR_FOLLOW_SIN_SABER,
      );
      return {
        atendido: true,
        que: "sigue sin seguir: se le ha contestado igual",
      };
    }
    await mensajeDirecto(
      cuenta.token,
      cuenta.igUserId,
      igsid,
      seSabe ? RECORDATORIO_FOLLOW : PEDIR_FOLLOW_SIN_SABER,
    );
    await db
      .update(magnetContacts)
      .set({ followAsks: fila.contacto.followAsks + 1 })
      .where(eq(magnetContacts.id, fila.contacto.id));
    return {
      atendido: true,
      que: seSabe
        ? "no sigue: se le ha recordado"
        : "no se pudo comprobar: se le ha pedido sin afirmar nada",
    };
  }

  // Sí sigue: se le entrega.
  const entrega = await entregarRecurso({
    iman: fila.iman,
    cuentaId: fila.cuenta.id,
    token: cuenta.token,
    igUserId: cuenta.igUserId,
    contacto: fila.contacto,
    igsid,
    username: perfil.username ?? fila.contacto.username,
    dijo: texto,
    via: { hilo: true },
  });

  return {
    atendido: true,
    que: "sigue: recurso entregado",
    detalle: entrega.mensaje,
  };
}

/**
 * Componer el recurso y entregarlo. El único sitio donde se entrega.
 *
 * Hay dos formas de llegar aquí: alguien que comenta la palabra y resulta que
 * ya te sigue, y alguien a quien se le pidió el follow y contesta. El mensaje,
 * el lead, los toques y el filtro de precios tienen que ser idénticos en los
 * dos casos, y la única manera de garantizarlo es que haya un solo camino.
 *
 * Lo único que cambia es POR DÓNDE sale, y no es un detalle: a quien nunca te
 * ha escrito no se le puede mandar un privado normal —no hay conversación
 * abierta—, pero sí uno anclado a su comentario, que Meta acepta durante siete
 * días. Es exactamente lo que permite contestar al instante a un desconocido.
 */
async function entregarRecurso(opciones: {
  iman: typeof leadMagnets.$inferSelect;
  cuentaId: string;
  token: string;
  igUserId: string;
  contacto: typeof magnetContacts.$inferSelect;
  igsid: string | null;
  username: string;
  /** Lo que dijo esa persona: su comentario o su mensaje. */
  dijo: string;
  via: { comentario: string } | { hilo: true };
}): Promise<{ mensaje: string }> {
  const { iman, contacto, username } = opciones;

  const ajustes = await ajustesEfectivos(iman.workspaceId);
  const systemPrompt = await promptDeCampana(await campanaDelImanId(iman));
  let mensaje = iman.resource;
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
            nombre: username,
            clave: iman.keyword,
            recurso: iman.resource,
            comentario: opciones.dijo,
          }),
        },
      ],
    });
    mensaje = r.text.trim();
  } catch {
    // Sin modelo se manda el recurso a secas: es lo prometido, y eso no falla.
  }

  // El mismo filtro que el resto del sistema: ninguna cifra de dinero por chat.
  if (mencionaDinero(mensaje)) mensaje = iman.resource;
  // Y el recurso tiene que ir sí o sí: es lo único que se ha prometido.
  if (faltaElRecurso(mensaje, iman.resource)) {
    mensaje = `${mensaje}\n\n${iman.resource}`;
  }

  /**
   * Se guarda LO QUE SE MANDA, no solo que se mandó.
   *
   * Una entrega que Meta acepta con un 200 y que luego no aparece en el chat es
   * indistinguible desde aquí de una que sí llegó. Sin el texto delante no hay
   * forma de saber si el problema fue el envío o lo que se compuso.
   */
  const envio =
    "comentario" in opciones.via
      ? await mensajePrivadoAlComentario(
          opciones.token,
          opciones.igUserId,
          opciones.via.comentario,
          mensaje,
        )
      : await mensajeDirecto(
          opciones.token,
          opciones.igUserId,
          opciones.igsid!,
          mensaje,
        );
  await db.insert(runLogs).values({
    workflow: "iman",
    level: "info",
    message: `Recurso enviado a @${username}`,
    payload: {
      igsid: opciones.igsid,
      via: "comentario" in opciones.via ? "comentario" : "hilo",
      messageId: envio.message_id ?? null,
      largo: mensaje.length,
      texto: mensaje.slice(0, 500),
    },
  });

  /**
   * A partir de aquí es un lead, no un contacto de un imán.
   *
   * El imán ha cumplido: comprobó y entregó. Lo que venga después —qué tal le
   * ha ido, si encaja, cerrar una reunión— es trabajo del agente, y el agente
   * solo sabe hablar de leads. Sin esta fila, la conversación se acaba justo en
   * el mejor momento: cuando esa persona acaba de recibir algo tuyo y está
   * mirando el móvil.
   */
  const leadId = opciones.igsid
    ? await asegurarLeadDelIman(iman, contacto, opciones.igsid, { username })
    : null;

  /**
   * Y la conversación se guarda como toques del lead.
   *
   * `touches` es de donde lee TODO el sistema para saber qué se ha hablado ya:
   * el agente entrante, el seguimiento, el panel. El imán mandaba sus mensajes
   * por su cuenta y no dejaba ninguna fila ahí, así que cuando el agente cogía
   * la conversación veía un historial vacío y escribía un primer contacto en
   * frío —"no nos conocemos de nada"— a alguien que acababa de pedirle algo y
   * de recibirlo. Nada delata más rápido que detrás no hay una persona.
   *
   * Se guardan los dos lados: lo que dijo y lo que le mandamos.
   */
  if (leadId) {
    /**
     * Un segundo entre lo que dijo y lo que le contestamos.
     *
     * Los dos toques se insertan a la vez, y en Postgres `now()` es la hora de
     * la transacción: con la misma marca, el orden entre ellos queda al azar y
     * el historial podía leerse al revés, con nuestra respuesta antes que su
     * pregunta. El agente que recoge la conversación después decide qué decir
     * leyendo eso.
     *
     * Se escribe la marca a mano en vez de dejar el valor por defecto, para que
     * la que se guarda sea la misma que dice el toque y no la del momento en
     * que la base de datos ejecutó la inserción.
     */
    const ahora = new Date();
    const respondido = new Date(ahora.getTime() + 1000);
    await db.insert(touches).values([
      {
        leadId,
        accountId: opciones.cuentaId,
        channel: "instagram" as const,
        direction: "in" as const,
        status: "enviado" as const,
        step: 1,
        body: opciones.dijo,
        sentAt: ahora,
        createdAt: ahora,
      },
      {
        leadId,
        accountId: opciones.cuentaId,
        channel: "instagram" as const,
        direction: "out" as const,
        status: "enviado" as const,
        step: 1,
        body: mensaje,
        sentAt: respondido,
        createdAt: respondido,
      },
    ]);
    // El siguiente mensaje del agente es el segundo, no el primero.
    await db.update(leads).set({ touchCount: 1 }).where(eq(leads.id, leadId));
  }

  await db
    .update(magnetContacts)
    .set({
      state: "entregado",
      verifiedAt: new Date(),
      deliveredAt: new Date(),
      leadId,
    })
    .where(eq(magnetContacts.id, contacto.id));

  await db.insert(runLogs).values({
    workflow: "iman",
    level: "info",
    message: `@${username} sigue a la cuenta: recurso entregado.`,
    payload: { magnetId: iman.id, contactId: contacto.id },
  });

  return { mensaje };
}
