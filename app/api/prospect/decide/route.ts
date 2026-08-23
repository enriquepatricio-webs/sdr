import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { campaigns, leads, prospectSearches, prospects } from "@/lib/db/schema";
import { jsonError, parseBody, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const cuerpo = z.object({
  ids: z.array(z.string().uuid()).min(1),
  decision: z.enum(["importado", "descartado"]),
  campaignId: z.string().uuid().optional(),
});

/**
 * Saca candidatos de la sala de espera: al embudo o a la basura.
 *
 * Importar es el único punto en el que un perfil scrapeado se convierte en
 * alguien a quien el sistema va a escribir, así que es un acto explícito de una
 * persona y nunca un efecto secundario del scraping.
 */
/** Se distingue del resto de errores para poder devolver un 409 y no un 500. */
class ErrorDeEmpresa extends Error {}

export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo);
  if (!body.ok) return body.response;
  const { ids, decision, campaignId } = body.data;

  try {
    if (decision === "descartado") {
      await db
        .update(prospects)
        .set({ decision })
        .where(inArray(prospects.id, ids));
      return NextResponse.json({ descartados: ids.length });
    }

    if (!campaignId)
      return jsonError("Para importar hace falta decir a qué campaña.", 400);

    const [campana] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));
    if (!campana) return jsonError("Esa campaña no existe.", 404);

    /**
     * Los candidatos vienen con la empresa de la búsqueda que los encontró, y
     * tiene que ser la misma que la de la campaña de destino.
     *
     * Sin esta comprobación, la pantalla de prospección —que además lista las
     * búsquedas de todas las empresas— deja importar los restaurantes que buscó
     * un cliente a la campaña de LinkedIn de otro con un par de clics, y a
     * partir de ahí les escribe de verdad.
     */
    const candidatos = await db
      .select({ p: prospects, empresa: prospectSearches.workspaceId })
      .from(prospects)
      .innerJoin(prospectSearches, eq(prospects.searchId, prospectSearches.id))
      .where(inArray(prospects.id, ids))
      .then((filas) => {
        const ajenos = filas.filter(
          (f) => f.empresa !== null && f.empresa !== campana.workspaceId,
        );
        if (ajenos.length) {
          throw new ErrorDeEmpresa(
            `${ajenos.length} de esos candidatos son de otra empresa. No se pueden importar a esta campaña.`,
          );
        }
        return filas.map((f) => f.p);
      });

    const importados: string[] = [];
    const saltados: { nombre: string; motivo: string }[] = [];

    for (const c of candidatos) {
      if (c.decision === "importado" && c.leadId) {
        saltados.push({ nombre: c.fullName, motivo: "ya estaba importado" });
        continue;
      }

      // El canal de la campaña decide qué identificador hace falta. Meter un
      // perfil sin usuario de Instagram en una campaña de Instagram crearía un
      // lead que nunca se podría contactar.
      const identificadorNecesario =
        campana.channel === "instagram"
          ? c.instagramUsername
          : campana.channel === "email"
            ? c.email
            : (c.linkedinUrl ?? c.providerId);

      if (!identificadorNecesario) {
        saltados.push({
          nombre: c.fullName,
          motivo: `sin identificador de ${campana.channel}`,
        });
        continue;
      }

      const [lead] = await db
        .insert(leads)
        .values({
          campaignId,
          fullName: c.fullName,
          headline: c.headline,
          company: c.company,
          linkedinUrl: c.linkedinUrl,
          instagramUsername: c.instagramUsername,
          email: c.email,
          providerId: c.providerId,
          status: "nuevo",
          raw: {
            ...c.raw,
            origen: "prospeccion",
            prospect_id: c.id,
            icp_score: c.icpScore,
          },
        })
        // Si ya estaba en la campaña, no se duplica: el índice único lo impide.
        .onConflictDoNothing()
        .returning({ id: leads.id });

      if (!lead) {
        saltados.push({
          nombre: c.fullName,
          motivo: "ya estaba en esa campaña",
        });
        continue;
      }

      await db
        .update(prospects)
        .set({ decision: "importado", leadId: lead.id })
        .where(eq(prospects.id, c.id));
      importados.push(lead.id);
    }

    return NextResponse.json({ importados: importados.length, saltados });
  } catch (err) {
    if (err instanceof ErrorDeEmpresa) return jsonError(err.message, 409);
    return serverError(err, "No se pudo aplicar la decisión");
  }
}
