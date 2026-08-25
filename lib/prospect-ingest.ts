/**
 * Ingesta de una búsqueda de prospección terminada.
 *
 * Vive aquí y no en la ruta porque la llaman dos: el sondeo del dashboard
 * (cuando alguien mira la pantalla) y el reabastecimiento automático (cada
 * media hora, mire alguien o no). Mientras solo la tenía la ruta, una búsqueda
 * automática lanzada de madrugada se quedaba en "ejecutando" para siempre si
 * nadie abría el navegador: no llegaban leads, la campaña seguía vacía, y el
 * reabastecimiento pagaba otra búsqueda cada 30 minutos para nada.
 */
import { and, asc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "./db";
import {
  campaigns,
  icps,
  leads,
  normalizedEmail,
  normalizedHandle,
  normalizedLinkedinUrl,
  prospectSearches,
  prospects,
} from "./db/schema";
import {
  type ProspectSource,
  fuenteDeCanal,
  getDatasetItems,
  getRun,
  isFinished,
} from "./apify";
import { normalizarCandidato, puntuarCandidatos } from "./prospect";
import { ajustesEfectivos } from "./workspace";

/**
 * Identidades que el sistema ya conoce, para no volver a traerlas.
 *
 * Sin esto el reabastecimiento automático repite gente: el mismo perfil sale en
 * dos búsquedas distintas, se importa dos veces a campañas distintas y acaba
 * recibiendo dos mensajes nuestros. Los índices únicos son POR campaña y POR
 * búsqueda, así que no cubren este caso; hay que mirarlo a mano.
 *
 * Se mira SOLO dentro de la empresa. Que un restaurante ya esté en la campaña de
 * un cliente no es motivo para que otro cliente, que vende otra cosa, no pueda
 * hablar con él: mirar todas las empresas le robaba candidatos a la que había
 * pagado la búsqueda.
 */
export async function identidadesConocidas(
  workspaceId: string | null,
): Promise<{
  linkedin: Set<string>;
  instagram: Set<string>;
  email: Set<string>;
}> {
  const [deLeads, deProspectos] = await Promise.all([
    db
      .select({
        li: sql<string | null>`${normalizedLinkedinUrl(leads.linkedinUrl)}`,
        ig: sql<string | null>`${normalizedHandle(leads.instagramUsername)}`,
        em: sql<string | null>`${normalizedEmail(leads.email)}`,
      })
      .from(leads)
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(workspaceId ? eq(campaigns.workspaceId, workspaceId) : undefined),
    db
      .select({
        li: sql<string | null>`${normalizedLinkedinUrl(prospects.linkedinUrl)}`,
        ig: sql<
          string | null
        >`${normalizedHandle(prospects.instagramUsername)}`,
        em: sql<string | null>`${normalizedEmail(prospects.email)}`,
      })
      .from(prospects)
      .innerJoin(prospectSearches, eq(prospects.searchId, prospectSearches.id))
      .where(
        workspaceId ? eq(prospectSearches.workspaceId, workspaceId) : undefined,
      ),
  ]);

  const linkedin = new Set<string>();
  const instagram = new Set<string>();
  const email = new Set<string>();
  for (const f of [...deLeads, ...deProspectos]) {
    if (f.li) linkedin.add(f.li);
    if (f.ig) instagram.add(f.ig);
    if (f.em) email.add(f.em);
  }
  return { linkedin, instagram, email };
}

function normalizarLi(url: string | null): string | null {
  return url
    ? url
        .toLowerCase()
        .replace(/^https?:\/\/(www\.)?/, "")
        .replace(/\/+$/, "")
    : null;
}

export async function ingerir(
  searchId: string,
  icpId: string,
  workspaceId: string | null,
  source: ProspectSource,
  datasetId: string,
  costeApify: number | null,
) {
  const [icp] = await db.select().from(icps).where(eq(icps.id, icpId));
  // El umbral de auto-importación es el de ESA empresa: cada una decide a partir
  // de qué puntuación un candidato entra solo en su campaña.
  const ajustes = await ajustesEfectivos(workspaceId);

  /**
   * Solo lo que se pidió, no lo que el actor decidió devolver.
   *
   * Algunos actores ignoran el tope: se pedían 60 perfiles de Instagram y
   * devolvía 215. Puntuar cuesta una llamada al modelo por cada doce, así que
   * traer de más multiplica la factura por algo que nadie encargó. Un poco de
   * margen sí, por si vienen filas inservibles que se caen al normalizar.
   */
  const tope = Math.min(500, Math.round(ajustes.autoProspectMaxItems * 1.5));
  const crudos = await getDatasetItems(datasetId, { limit: tope });
  const conocidas = await identidadesConocidas(workspaceId);

  const todos = crudos
    .map((item) => normalizarCandidato(source, item))
    .filter((c): c is NonNullable<typeof c> => c !== null);

  // Fuera los que ya están en el sistema: puntuarlos cuesta dinero y no aportan.
  const normalizados = todos.filter((c) => {
    const li = normalizarLi(c.linkedinUrl);
    const ig = c.instagramUsername?.toLowerCase().replace(/^@/, "").trim();
    const em = c.email?.toLowerCase();
    if (li && conocidas.linkedin.has(li)) return false;
    if (ig && conocidas.instagram.has(ig)) return false;
    if (em && conocidas.email.has(em)) return false;
    return true;
  });

  const yaConocidos = todos.length - normalizados.length;

  const { puntuaciones, costeUsd } = normalizados.length
    ? await puntuarCandidatos(icp, normalizados, ajustes.openrouterModel)
    : { puntuaciones: new Map(), costeUsd: 0 };

  let encajan = 0;
  let descartados = 0;

  if (normalizados.length) {
    const filas = normalizados.map((c, i) => {
      const p = puntuaciones.get(i);
      if (p?.verdict === "encaja") encajan++;
      if (p?.verdict === "no_encaja") descartados++;
      return {
        searchId,
        fullName: c.fullName,
        headline: c.headline,
        company: c.company,
        location: c.location,
        linkedinUrl: c.linkedinUrl,
        instagramUsername: c.instagramUsername,
        email: c.email,
        providerId: c.providerId,
        icpScore: p?.score ?? null,
        icpVerdict: p?.verdict ?? null,
        icpReasoning: p?.reasoning ?? null,
        raw: c.raw,
      };
    });

    // Un actor devuelve duplicados con frecuencia; los índices únicos por
    // búsqueda los rechazan y aquí simplemente se ignoran.
    await db.insert(prospects).values(filas).onConflictDoNothing();
  }

  const previo = (
    await db
      .select()
      .from(prospectSearches)
      .where(eq(prospectSearches.id, searchId))
  )[0];

  /**
   * Auto-importación.
   *
   * Solo en búsquedas del reabastecimiento automático (`autoImport`), solo por
   * encima del umbral configurado y solo con veredicto "encaja". Todo lo demás
   * se queda en la sala de espera para que lo mire una persona.
   *
   * Esto mete leads en la campaña; NO autoriza a enviarles nada. Cuántos
   * mensajes salen lo sigue decidiendo el cupo de /api/leads/next.
   */
  let autoImportados = 0;
  if (previo?.autoImport && previo.campaignId) {
    const [campana] = await db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, previo.campaignId));
    if (campana) {
      const candidatos = await db
        .select()
        .from(prospects)
        .where(
          and(
            eq(prospects.searchId, searchId),
            eq(prospects.decision, "pendiente"),
            eq(prospects.icpVerdict, "encaja"),
            gte(prospects.icpScore, ajustes.autoProspectMinScore),
          ),
        );

      for (const c of candidatos) {
        const identificador =
          campana.channel === "instagram"
            ? c.instagramUsername
            : campana.channel === "email"
              ? c.email
              : (c.linkedinUrl ?? c.providerId);
        if (!identificador) continue;

        const [lead] = await db
          .insert(leads)
          .values({
            campaignId: campana.id,
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
              origen: "reabastecimiento",
              prospect_id: c.id,
              icp_score: c.icpScore,
            },
          })
          .onConflictDoNothing()
          .returning({ id: leads.id });

        if (!lead) continue;
        await db
          .update(prospects)
          .set({ decision: "importado", leadId: lead.id })
          .where(eq(prospects.id, c.id));
        autoImportados++;
      }
    }
  }

  await db
    .update(prospectSearches)
    .set({
      status: "completada",
      stats: {
        encontrados: crudos.length,
        yaConocidos,
        autoImportados,
        puntuados: puntuaciones.size,
        encajan,
        descartados,
        coste_apify_usd: costeApify ?? undefined,
        coste_llm_usd: (previo?.stats?.coste_llm_usd ?? 0) + costeUsd,
      },
    })
    .where(eq(prospectSearches.id, searchId));
}

/**
 * Recoge las búsquedas que ya han terminado en Apify y todavía no se han
 * ingerido. Lo llama el reabastecimiento en cada vuelta.
 *
 * Es lo que cierra el círculo del "que no pare nunca": sin esto, una búsqueda
 * lanzada de madrugada se queda esperando a que alguien abra el dashboard.
 *
 * El reclamo (`ejecutando` -> `puntuando` con UPDATE condicional) es el mismo
 * que usa el sondeo del panel, así que los dos pueden correr a la vez sin
 * ingerir dos veces: solo gana quien consigue cambiar la fila.
 */
export async function barrerBusquedasPendientes(limite = 5): Promise<{
  ingeridas: string[];
  fallidas: { id: string; error: string }[];
}> {
  const pendientes = await db
    .select()
    .from(prospectSearches)
    .where(
      and(
        eq(prospectSearches.status, "ejecutando"),
        isNotNull(prospectSearches.apifyRunId),
      ),
    )
    .orderBy(asc(prospectSearches.createdAt))
    .limit(limite);

  const ingeridas: string[] = [];
  const fallidas: { id: string; error: string }[] = [];

  for (const busqueda of pendientes) {
    try {
      const run = await getRun(busqueda.apifyRunId!);
      if (!isFinished(run.status)) continue;

      if (run.status !== "SUCCEEDED") {
        await db
          .update(prospectSearches)
          .set({
            status: "fallida",
            error:
              `Apify terminó en ${run.status}. ${run.statusMessage ?? ""}`.trim(),
          })
          .where(eq(prospectSearches.id, busqueda.id));
        fallidas.push({ id: busqueda.id, error: run.status });
        continue;
      }

      const reclamado = await db
        .update(prospectSearches)
        .set({ status: "puntuando" })
        .where(
          and(
            eq(prospectSearches.id, busqueda.id),
            eq(prospectSearches.status, "ejecutando"),
          ),
        )
        .returning({ id: prospectSearches.id });
      if (!reclamado.length) continue;

      await ingerir(
        busqueda.id,
        busqueda.icpId,
        busqueda.workspaceId,
        // Búsquedas viejas de Instagram: la fuente ya no existe, pero sus
        // resultados siguen guardados y no hay motivo para perderlos.
        fuenteDeCanal(busqueda.source) ?? "email",
        run.defaultDatasetId,
        run.costUsd,
      );
      ingeridas.push(busqueda.id);
    } catch (err) {
      const detalle = err instanceof Error ? err.message : String(err);
      // Se libera el reclamo: si se queda en "puntuando" nadie vuelve a
      // intentarlo nunca y el dataset, que ya está pagado, se pierde.
      await db
        .update(prospectSearches)
        .set({ status: "ejecutando", error: detalle })
        .where(eq(prospectSearches.id, busqueda.id));
      fallidas.push({ id: busqueda.id, error: detalle });
    }
  }

  return { ingeridas, fallidas };
}
