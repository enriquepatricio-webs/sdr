import { NextResponse } from "next/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { prospectSearches, prospects } from "@/lib/db/schema";
import { jsonError, serverError } from "@/lib/api";
import { fuenteDeCanal, getRun, isFinished } from "@/lib/apify";
import { ingerir } from "@/lib/prospect-ingest";

export const dynamic = "force-dynamic";
// La puntuación con el LLM va por lotes y puede tardar.
export const maxDuration = 300;

/**
 * Sondeo del estado de una búsqueda. Hace tres cosas según en qué punto esté:
 * informar, ingerir el resultado, o devolver los candidatos ya puntuados.
 *
 * Es idempotente: dos sondeos simultáneos no ingieren dos veces porque el paso
 * a 'puntuando' es un UPDATE condicional que solo gana uno.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const [busqueda] = await db
      .select()
      .from(prospectSearches)
      .where(eq(prospectSearches.id, id));
    if (!busqueda) return jsonError("Esa búsqueda no existe.", 404);

    if (busqueda.status === "ejecutando" && busqueda.apifyRunId) {
      const run = await getRun(busqueda.apifyRunId);

      if (!isFinished(run.status)) {
        return NextResponse.json({
          estado: "ejecutando",
          apify: run.status,
          prospectos: [],
        });
      }

      if (run.status !== "SUCCEEDED") {
        await db
          .update(prospectSearches)
          .set({
            status: "fallida",
            error:
              `Apify terminó en ${run.status}. ${run.statusMessage ?? ""}`.trim(),
          })
          .where(eq(prospectSearches.id, id));
        return NextResponse.json({
          estado: "fallida",
          apify: run.status,
          prospectos: [],
        });
      }

      // Reclamo: solo la primera petición que consiga cambiar el estado ingiere.
      const reclamado = await db
        .update(prospectSearches)
        .set({ status: "puntuando" })
        .where(
          and(
            eq(prospectSearches.id, id),
            eq(prospectSearches.status, "ejecutando"),
          ),
        )
        .returning({ id: prospectSearches.id });

      if (reclamado.length) {
        try {
          await ingerir(
            id,
            busqueda.icpId,
            busqueda.workspaceId,
            // Búsquedas viejas de Instagram: la fuente ya no existe, pero sus
            // resultados siguen guardados y no hay motivo para perderlos.
            fuenteDeCanal(busqueda.source) ?? "email",
            run.defaultDatasetId,
            run.costUsd,
          );
        } catch (err) {
          // Se devuelve a 'ejecutando'. Si se queda en 'puntuando' nadie vuelve
          // a intentarlo nunca y el dataset, que ya está pagado, se pierde.
          await db
            .update(prospectSearches)
            .set({
              status: "ejecutando",
              error: err instanceof Error ? err.message : String(err),
            })
            .where(eq(prospectSearches.id, id));
          throw err;
        }
      }
    }

    const [actual] = await db
      .select()
      .from(prospectSearches)
      .where(eq(prospectSearches.id, id));
    const candidatos = await db
      .select()
      .from(prospects)
      .where(eq(prospects.searchId, id))
      .orderBy(desc(prospects.icpScore), asc(prospects.fullName));

    return NextResponse.json({
      estado: actual.status,
      error: actual.error,
      stats: actual.stats,
      razonamiento: actual.inputReasoning,
      filtros: actual.input,
      prospectos: candidatos,
    });
  } catch (err) {
    return serverError(err, "No se pudo consultar la búsqueda");
  }
}
