import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  accounts,
  leadMagnets,
  magnetContacts,
  runLogs,
} from "@/lib/db/schema";
import { jsonError, parseBody, serverError } from "@/lib/api";
import { tokenDeCuenta } from "@/lib/instagram-cuenta";
import {
  comentariosDeMedia,
  mediaDeUrl,
  mensajePrivadoAlComentario,
  responderComentario,
} from "@/lib/instagram";
import {
  RESPUESTA_PUBLICA,
  comentariosConLaClave,
  promptDeEntrega,
} from "@/lib/magnets";
import { chat } from "@/lib/openrouter";
import { promptDeCampana } from "@/lib/playbook";
import { campanaDelImanId } from "@/lib/magnets-campana";
import { ajustesEfectivos } from "@/lib/workspace";
import { mencionaDinero } from "@/lib/sin-precios";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Lee los comentarios de la publicación del imán y entrega el recurso.
 *
 * Con `ensayo: true` no escribe a nadie: devuelve exactamente lo que haría.
 * Existe porque esto manda mensajes a personas reales, y una vez enviados no
 * hay vuelta atrás: poder verlo antes cuesta un parámetro.
 */
const cuerpo = z.object({
  ensayo: z.boolean().default(true),
  /** Tope por vuelta. Evita que un post con cien comentarios dispare cien DMs. */
  maximo: z.number().int().min(1).max(50).default(10),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await parseBody(request, cuerpo);
  if (!body.ok) return body.response;
  const { ensayo, maximo } = body.data;

  try {
    const [fila] = await db
      .select({ iman: leadMagnets, cuenta: accounts })
      .from(leadMagnets)
      .innerJoin(accounts, eq(accounts.id, leadMagnets.accountId))
      .where(eq(leadMagnets.id, id));
    if (!fila) return jsonError("Ese imán no existe.", 404);

    const cuenta = await tokenDeCuenta(fila.cuenta.id);
    if (!cuenta) {
      return jsonError(
        `La cuenta "${fila.cuenta.displayName}" no está autorizada en Instagram. Autorízala en /empresa.`,
        409,
      );
    }

    const mediaId = await mediaDeUrl(cuenta.token, fila.iman.postUrl);
    if (!mediaId) {
      return jsonError(
        `No encuentro esa publicación entre las de @${cuenta.username}. Comprueba que la URL del imán es de esta cuenta.`,
        404,
      );
    }

    const crudos = await comentariosDeMedia(cuenta.token, mediaId);
    // El núcleo del embudo espera la forma que traía el scraper. Se traduce
    // aquí, en el borde, para no tener dos deduplicaciones distintas.
    const conClave = comentariosConLaClave(
      crudos.map((c) => ({
        id: c.id,
        text: c.text,
        ownerUsername: c.username ?? c.from?.username,
        owner: { full_name: c.username ?? c.from?.username },
      })),
      fila.iman.keyword,
    );

    // Los que ya están registrados no se vuelven a tocar: es lo que impide
    // mandarle el recurso dos veces a quien comenta dos veces.
    const yaEstan = new Set(
      (
        await db
          .select({ username: magnetContacts.username })
          .from(magnetContacts)
          .where(eq(magnetContacts.magnetId, fila.iman.id))
      ).map((c) => c.username),
    );
    const nuevos = conClave.filter((c) => !yaEstan.has(c.username));

    const ajustes = await ajustesEfectivos(fila.iman.workspaceId);
    const campaignId = await campanaDelImanId(fila.iman);
    const systemPrompt = await promptDeCampana(campaignId);

    const hechos: unknown[] = [];
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
              comentario: c.text ?? fila.iman.keyword,
            }),
          },
        ],
      });
      let texto = r.text.trim();

      // El mismo filtro que el resto del sistema: ninguna cifra de dinero sale
      // por un chat. Si el modelo la mete, se manda el recurso a secas.
      if (mencionaDinero(texto)) {
        texto = fila.iman.resource;
      }
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
          comentario: c.text,
          publico,
          privado: texto,
        });
        continue;
      }

      const respuesta = await responderComentario(
        cuenta.token,
        c.commentId,
        publico,
      );
      const dm = await mensajePrivadoAlComentario(
        cuenta.token,
        cuenta.igUserId,
        c.commentId,
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
        message: `Imán "${fila.iman.name}": ${hechos.length} comentarios atendidos por la API de Meta.`,
        payload: { magnetId: fila.iman.id, mediaId },
      });
    }

    return NextResponse.json({
      ensayo,
      cuenta: `@${cuenta.username ?? fila.cuenta.displayName}`,
      comentariosLeidos: crudos.length,
      conLaClave: conClave.length,
      nuevos: nuevos.length,
      hechos,
    });
  } catch (err) {
    return serverError(err, "No se pudieron atender los comentarios");
  }
}
