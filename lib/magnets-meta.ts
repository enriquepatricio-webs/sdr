import { eq } from "drizzle-orm";
import { db } from "./db";
import { accounts, leadMagnets, magnetContacts, runLogs } from "./db/schema";
import { tokenDeCuenta } from "./instagram-cuenta";
import {
  comentariosDeMedia,
  mediaDeUrl,
  mensajePrivadoAlComentario,
  responderComentario,
} from "./instagram";
import {
  RESPUESTA_PUBLICA,
  comentariosConLaClave,
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

  const mediaId = await mediaDeUrl(cuenta.token, fila.iman.postUrl);
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

  const hechos: Record<string, unknown>[] = [];
  for (const c of nuevos.slice(0, maximo)) {
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
            nombre: c.fullName || c.username,
            clave: fila.iman.keyword,
            recurso: fila.iman.resource,
            comentario: textoDe.get(c.commentId!) ?? fila.iman.keyword,
          }),
        },
      ],
    });
    let texto = r.text.trim();

    // El mismo filtro que el resto del sistema: ninguna cifra de dinero sale
    // por un chat. Si el modelo la mete, se manda el recurso a secas.
    if (mencionaDinero(texto)) texto = fila.iman.resource;
    // El recurso tiene que ir sí o sí: es lo único que se ha prometido.
    if (!texto.includes(fila.iman.resource)) {
      texto = `${texto}\n\n${fila.iman.resource}`;
    }

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
      state: "entregado",
      deliveredAt: new Date(),
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
