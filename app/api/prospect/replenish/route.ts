import { NextResponse } from "next/server";
import { and, count, desc, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  campaigns,
  icps,
  leads,
  prospectSearches,
  runLogs,
} from "@/lib/db/schema";
import { serverError } from "@/lib/api";
import { SUPPORTED_ACTORS, startRun } from "@/lib/apify";
import { construirEntrada, traducirIcpAFiltros } from "@/lib/prospect";
import { barrerBusquedasPendientes } from "@/lib/prospect-ingest";
import { planificarReabastecimiento } from "@/lib/replenish";
import { getSettings } from "@/lib/settings";
import { ajustesEfectivos, listarWorkspaces } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Cuántas campañas se reabastecen como mucho en una vuelta. */
const CAMPANAS_POR_VUELTA = 4;

/**
 * Rellena la cola de leads cuando se está quedando vacía.
 *
 * Lo llama n8n en cada vuelta de W1. La idea es que el sistema no se pare nunca:
 * si una campaña en marcha se queda sin leads, busca más él solo.
 *
 * Dos frenos, y ninguno es opcional:
 *
 *  · GASTO — hay un tope de búsquedas automáticas al día. Cada una cuesta dinero
 *    en Apify y en el modelo, y un cron cada 30 minutos sin tope sería una
 *    factura sorpresa a fin de mes.
 *
 *  · ENVÍO — este endpoint NO toca los topes de envío. Llenar la cola de leads
 *    no autoriza ni un mensaje más: eso lo decide /api/leads/next con el cupo
 *    por cuenta, por campaña y por hora. Tener diez mil leads produce los mismos
 *    25 mensajes al día que tener diez.
 *
 * Y una campaña pausada nunca se reabastece: si has echado el freno de mano, el
 * sistema no puede rearmarse solo.
 *
 * El interruptor y el umbral de leads son de CADA empresa; el tope de búsquedas
 * al día es global y se reparte entre todas por orden de antigüedad. Si fuese
 * por empresa, cinco empresas multiplicarían la factura de Apify por cinco sin
 * que nadie hubiese decidido gastar cinco veces más.
 */
export async function POST() {
  try {
    // PRIMERO se recoge lo que ya está pagado y terminado. Si no, se lanzarían
    // búsquedas nuevas cada media hora mientras las anteriores esperan a que
    // alguien abra el dashboard, y la campaña seguiría vacía igual.
    const barrido = await barrerBusquedasPendientes();

    const globales = await getSettings();

    const inicioDelDia = new Date();
    inicioDelDia.setHours(0, 0, 0, 0);

    const [estados, [{ n: busquedasHoy } = { n: 0 }]] = await Promise.all([
      db
        .select({
          id: campaigns.id,
          name: campaigns.name,
          status: campaigns.status,
          icpId: campaigns.icpId,
          channel: campaigns.channel,
          workspaceId: campaigns.workspaceId,
          leadsPendientes: count(leads.id),
        })
        .from(campaigns)
        .leftJoin(
          leads,
          and(eq(leads.campaignId, campaigns.id), eq(leads.status, "nuevo")),
        )
        .groupBy(campaigns.id),
      db
        .select({ n: count() })
        .from(prospectSearches)
        .where(
          and(
            eq(prospectSearches.origin, "automatica"),
            gte(prospectSearches.createdAt, inicioDelDia),
          ),
        ),
    ]);

    /**
     * Primero la empresa que lleva más tiempo sin que se le busque nada.
     *
     * Se recorrían por antigüedad y solo caben unas pocas campañas por vuelta,
     * así que la empresa más antigua se llevaba todas las plazas y la otra no
     * prospectaba nunca: Aplavo se quedó con cero leads mientras The Coto
     * Company acumulaba cientos de candidatos.
     */
    const ultimaBusqueda = await db
      .select({
        workspaceId: prospectSearches.workspaceId,
        cuando: sql<string>`max(${prospectSearches.createdAt})`,
      })
      .from(prospectSearches)
      .where(eq(prospectSearches.origin, "automatica"))
      .groupBy(prospectSearches.workspaceId);
    const cuandoPor = new Map(
      ultimaBusqueda.map((f) => [f.workspaceId, f.cuando]),
    );

    const empresas = (await listarWorkspaces()).sort((a, b) =>
      String(cuandoPor.get(a.id) ?? "").localeCompare(
        String(cuandoPor.get(b.id) ?? ""),
      ),
    );
    const lanzadas: {
      empresa: string;
      campana: string;
      busquedaId: string;
      angulo: string;
    }[] = [];
    const saltadas: { empresa: string; motivo: string; detalle?: string }[] =
      [];

    for (const empresa of empresas) {
      const ajustes = await ajustesEfectivos(empresa.id);
      const suyas = estados.filter((c) => c.workspaceId === empresa.id);
      if (!suyas.length) continue;

      const plan = planificarReabastecimiento({
        activo: ajustes.autoProspect,
        campanas: suyas.map((c) => ({
          ...c,
          leadsPendientes: Number(c.leadsPendientes),
        })),
        // El presupuesto del día se comparte: lo que ya ha gastado otra empresa
        // en esta misma vuelta cuenta para todas.
        busquedasAutomaticasHoy: Number(busquedasHoy) + lanzadas.length,
        maxBusquedasDia: globales.autoProspectMaxSearchesPerDay,
        minLeads: ajustes.autoProspectMinLeads,
      });

      if (!plan.procede) {
        saltadas.push({
          empresa: empresa.name,
          motivo: plan.motivo,
          detalle: plan.detalle,
        });
        continue;
      }

      // Como mucho unas pocas por vuelta: cada una lleva una llamada al modelo
      // para traducir el ICP a filtros, y ocho seguidas no caben en los 300 s
      // de la función. El cron pasa cada media hora, así que no se pierde nada.
      const hueco = CAMPANAS_POR_VUELTA - lanzadas.length;
      if (hueco <= 0) break;

      await lanzarPara(
        empresa.name,
        plan.campanas.slice(0, hueco),
        ajustes,
        estados,
        lanzadas,
        globales.autoProspectMaxSearchesPerDay,
        inicioDelDia,
      );
    }

    await db.insert(runLogs).values({
      workflow: "sdr-reabastecer",
      level: "info",
      message: `Reabastecimiento: ${lanzadas.length} búsquedas lanzadas`,
      payload: {
        lanzadas,
        saltadas,
        barrido,
        busquedasHoy: Number(busquedasHoy),
      },
    });

    return NextResponse.json({
      lanzadas: lanzadas.length,
      busquedas: lanzadas,
      saltadas,
    });
  } catch (err) {
    return serverError(err, "No se pudo reabastecer");
  }
}

type Estado = {
  id: string;
  name: string;
  channel: "linkedin" | "email" | "instagram";
};

async function lanzarPara(
  empresa: string,
  objetivos: { id: string; icpId: string }[],
  ajustes: Awaited<ReturnType<typeof ajustesEfectivos>>,
  estados: Estado[],
  lanzadas: {
    empresa: string;
    campana: string;
    busquedaId: string;
    angulo: string;
  }[],
  topeDiario: number,
  inicioDelDia: Date,
) {
  for (const objetivo of objetivos) {
    const campana = estados.find((c) => c.id === objetivo.id);
    if (!campana) continue;
    // El canal ES la fuente: para mandar un correo hace falta un correo, y eso
    // solo lo da Google Maps.
    const fuente = campana.channel;

    const [icp] = await db
      .select()
      .from(icps)
      .where(eq(icps.id, objetivo.icpId));
    if (!icp) continue;

    // Ángulos ya probados con este ICP: el modelo tiene que traer otro.
    const previos = await db
      .select({ angle: prospectSearches.angle })
      .from(prospectSearches)
      .where(
        and(
          eq(prospectSearches.icpId, icp.id),
          isNotNull(prospectSearches.angle),
        ),
      )
      .orderBy(desc(prospectSearches.createdAt))
      .limit(15);

    const filtros = await traducirIcpAFiltros(
      icp,
      fuente,
      null,
      ajustes.openrouterModel,
      previos.map((p) => p.angle!).filter(Boolean),
    );

    const actor = SUPPORTED_ACTORS[fuente].actor;
    const input = construirEntrada(
      fuente,
      filtros.input,
      ajustes.autoProspectMaxItems,
    );

    const [busqueda] = await db
      .insert(prospectSearches)
      .values({
        icpId: icp.id,
        campaignId: campana.id,
        // Sin esto la ingesta usa el umbral de auto-importación de la primera
        // empresa y mete en la campaña de un cliente candidatos que el suyo
        // habría descartado.
        workspaceId: ajustes.workspace?.id ?? null,
        name: `Auto · ${filtros.angulo}`,
        source: fuente,
        origin: "automatica",
        angle: filtros.angulo,
        // Solo el reabastecimiento importa solo, y solo por encima del umbral.
        autoImport: true,
        actor,
        input,
        inputReasoning: filtros.razonamiento,
        status: "pendiente",
        stats: {
          encontrados: 0,
          puntuados: 0,
          encajan: 0,
          descartados: 0,
          coste_llm_usd: filtros.usage.cost ?? 0,
        },
      })
      .returning({ id: prospectSearches.id });

    try {
      const run = await startRun(actor, input, {
        maxItems: ajustes.autoProspectMaxItems,
      });
      await db
        .update(prospectSearches)
        .set({
          apifyRunId: run.id,
          apifyDatasetId: run.defaultDatasetId,
          status: "ejecutando",
        })
        .where(eq(prospectSearches.id, busqueda.id));

      lanzadas.push({
        empresa,
        campana: campana.name,
        busquedaId: busqueda.id,
        angulo: filtros.angulo,
      });
    } catch (err) {
      await db
        .update(prospectSearches)
        .set({
          status: "fallida",
          error: err instanceof Error ? err.message : String(err),
        })
        .where(eq(prospectSearches.id, busqueda.id));
    }
  }
}

/** Estado del reabastecimiento, para el panel. */
export async function GET() {
  try {
    const globales = await getSettings();
    const empresas = await listarWorkspaces();
    const inicioDelDia = new Date();
    inicioDelDia.setHours(0, 0, 0, 0);

    const [[{ n: hoy } = { n: 0 }], enMarcha] = await Promise.all([
      db
        .select({ n: count() })
        .from(prospectSearches)
        .where(
          and(
            eq(prospectSearches.origin, "automatica"),
            gte(prospectSearches.createdAt, inicioDelDia),
          ),
        ),
      db
        .select({ n: count() })
        .from(prospectSearches)
        .where(ne(prospectSearches.status, "completada")),
    ]);

    return NextResponse.json({
      activo: empresas.some((e) => e.autoProspect),
      empresasActivas: empresas
        .filter((e) => e.autoProspect)
        .map((e) => e.name),
      busquedasHoy: Number(hoy),
      maxDia: globales.autoProspectMaxSearchesPerDay,
      enCurso: Number(enMarcha[0]?.n ?? 0),
    });
  } catch (err) {
    return serverError(err, "No se pudo leer el estado del reabastecimiento");
  }
}
