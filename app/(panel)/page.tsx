import Link from "next/link";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  campaigns,
  leads,
  meetings,
  runLogs,
  touches,
} from "@/lib/db/schema";
import { ajustesEfectivos, workspaceActivo } from "@/lib/workspace";
import { MINIMO_PARA_APRENDER, obtenerMuestras } from "@/lib/insights";
import { ParadaDeEmergencia } from "./parada";
import { Aprendizaje } from "./aprendizaje";

export const dynamic = "force-dynamic";

const EMBUDO = [
  { estado: "nuevo", etiqueta: "Nuevos" },
  { estado: "contactado", etiqueta: "Contactados" },
  { estado: "en_seguimiento", etiqueta: "En seguimiento" },
  { estado: "respondido", etiqueta: "Respondieron" },
  { estado: "cualificando", etiqueta: "Cualificando" },
  { estado: "cualificado", etiqueta: "Cualificados" },
  { estado: "agendado", etiqueta: "Agendados" },
] as const;

const SALIDAS = [
  { estado: "no_interesado", etiqueta: "No interesados" },
  { estado: "descartado", etiqueta: "Descartados" },
  { estado: "revision_humana", etiqueta: "En revisión" },
  { estado: "error", etiqueta: "Con error" },
] as const;

function Kpi({
  etiqueta,
  valor,
  nota,
  href,
}: {
  etiqueta: string;
  valor: string;
  nota?: string;
  href?: string;
}) {
  const cuerpo = (
    <>
      <p className="etiqueta">{etiqueta}</p>
      <p className="mt-1 font-mono text-3xl leading-none">{valor}</p>
      {nota && <p className="mt-1 text-xs text-tenue">{nota}</p>}
    </>
  );
  // Las reuniones son el resultado del sistema: se llega a ellas desde aquí,
  // que es donde se mira el número, y no desde un menú que ya tiene bastante.
  return href ? (
    <Link
      href={href}
      className="block border border-linea bg-lienzo p-4 transition-colors hover:border-tinta"
    >
      {cuerpo}
    </Link>
  ) : (
    <div className="border border-linea bg-lienzo p-4">{cuerpo}</div>
  );
}

export default async function Panel() {
  const hace30dias = new Date(Date.now() - 30 * 24 * 3600_000);
  // El autopiloto y las lecciones son de la empresa con la que se trabaja, no
  // de un global: pintar otra cosa aquí sería mentir sobre quién está enviando.
  const empresa = await workspaceActivo();

  /**
   * Todo lo que se pinta aquí es de ESTA empresa.
   *
   * Sin el filtro, el panel del cliente A enseñaba los leads, los envíos y las
   * reuniones del cliente B sumados a los suyos: un embudo que no cuadra con
   * nada y un "reuniones este mes" que no es suyo.
   *
   * El coste de OpenRouter se queda global a propósito: es una factura única y
   * repartirla por empresa sería inventarse un reparto.
   */
  const deLaEmpresa = empresa
    ? eq(campaigns.workspaceId, empresa.id)
    : undefined;

  const [
    porEstado,
    contactados,
    respuestas,
    reuniones,
    activas,
    ajustes,
    coste,
    muestras,
    porCampana,
  ] = await Promise.all([
    db
      .select({ status: leads.status, n: count() })
      .from(leads)
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(deLaEmpresa)
      .groupBy(leads.status),
    db
      .select({ n: count() })
      .from(touches)
      .innerJoin(leads, eq(touches.leadId, leads.id))
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(
        and(
          eq(touches.direction, "out"),
          eq(touches.status, "enviado"),
          gte(touches.sentAt, hace30dias),
          deLaEmpresa,
        ),
      ),
    db
      .select({ n: sql<number>`count(distinct ${touches.leadId})::int` })
      .from(touches)
      .innerJoin(leads, eq(touches.leadId, leads.id))
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(
        and(
          eq(touches.direction, "in"),
          gte(touches.createdAt, hace30dias),
          deLaEmpresa,
        ),
      ),
    db
      .select({ n: count() })
      .from(meetings)
      .innerJoin(leads, eq(meetings.leadId, leads.id))
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(and(gte(meetings.createdAt, hace30dias), deLaEmpresa)),
    db
      .select({ n: count() })
      .from(campaigns)
      .where(and(eq(campaigns.status, "running"), deLaEmpresa)),
    ajustesEfectivos(empresa?.id).catch(() => null),
    // Coste real de OpenRouter: se acumula desde los registros que lo llevan.
    db
      .select({
        total: sql<number>`coalesce(sum((${runLogs.payload}->>'coste_usd')::numeric), 0)::float`,
      })
      .from(runLogs)
      .where(gte(runLogs.createdAt, hace30dias)),
    obtenerMuestras(200, empresa?.id).catch(() => []),
    /**
     * Qué ha hecho cada campaña. El panel decía "4 contactados" sin decir de
     * quién, y sobre todo sin decir que había 109 envíos FALLIDOS: como un
     * fallo no se reintenta nunca, esos leads estaban quemados y no se veía en
     * ninguna pantalla.
     */
    db
      .select({
        campana: campaigns.name,
        canal: campaigns.channel,
        estado: campaigns.status,
        cuenta: accounts.displayName,
        enviados: sql<number>`count(*) filter (where ${touches.status} = 'enviado')::int`,
        borradores: sql<number>`count(*) filter (where ${touches.status} = 'borrador')::int`,
        fallidos: sql<number>`count(*) filter (where ${touches.status} = 'fallido')::int`,
      })
      .from(campaigns)
      .leftJoin(accounts, eq(accounts.id, campaigns.accountId))
      .leftJoin(leads, eq(leads.campaignId, campaigns.id))
      .leftJoin(
        touches,
        and(
          eq(touches.leadId, leads.id),
          eq(touches.direction, "out"),
          gte(touches.createdAt, hace30dias),
        ),
      )
      .where(deLaEmpresa)
      .groupBy(
        campaigns.id,
        campaigns.name,
        campaigns.channel,
        campaigns.status,
        accounts.displayName,
      )
      .orderBy(campaigns.name),
  ]);

  const conteo = new Map(porEstado.map((r) => [r.status, Number(r.n)]));
  const total = porEstado.reduce((s, r) => s + Number(r.n), 0);
  const maximo = Math.max(1, ...EMBUDO.map((e) => conteo.get(e.estado) ?? 0));

  const nContactados = Number(contactados[0]?.n ?? 0);
  const nRespuestas = Number(respuestas[0]?.n ?? 0);
  const nCualificados =
    (conteo.get("cualificado") ?? 0) + (conteo.get("agendado") ?? 0);
  const nReuniones = Number(reuniones[0]?.n ?? 0);
  const costeUsd = Number(coste[0]?.total ?? 0);

  const pct = (parte: number, sobre: number) =>
    sobre ? `${Math.round((parte / sobre) * 100)} %` : "—";

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="etiqueta">Últimos 30 días</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            {total} {total === 1 ? "lead" : "leads"} en el sistema
          </h1>
          <p className="mt-1 text-sm text-apagado">
            {Number(activas[0]?.n ?? 0)} campañas en marcha · autopiloto{" "}
            {ajustes?.autopilot ? (
              <span className="font-semibold text-vivo">encendido</span>
            ) : (
              "apagado"
            )}
          </p>
        </div>
        <ParadaDeEmergencia campanasActivas={Number(activas[0]?.n ?? 0)} />
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi
          etiqueta="Contactados"
          valor={String(nContactados)}
          nota="mensajes enviados"
        />
        <Kpi
          etiqueta="Tasa de respuesta"
          valor={pct(nRespuestas, nContactados)}
          nota={`${nRespuestas} contestaron`}
        />
        <Kpi
          etiqueta="Tasa de cualificación"
          valor={pct(nCualificados, nRespuestas)}
          nota={`${nCualificados} cualificados`}
        />
        <Kpi
          etiqueta="Reuniones"
          valor={String(nReuniones)}
          nota="agendadas · verlas"
          href="/meetings"
        />
        <Kpi
          etiqueta="Coste del modelo"
          valor={costeUsd ? `${costeUsd.toFixed(2)} $` : "—"}
          nota="OpenRouter, coste real"
        />
      </div>

      <Aprendizaje
        lecciones={ajustes?.lessons ?? null}
        muestras={muestras.length}
        minimo={MINIMO_PARA_APRENDER}
        workspaceId={empresa?.id ?? null}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* Quién ha hecho qué. Sin esto, "4 contactados" no dice de qué cuenta
          sale, y sobre todo no dice que hubo envíos que fallaron. */}
        <section className="border border-linea bg-lienzo p-4">
          <div className="flex items-baseline justify-between">
            <p className="etiqueta">Por campaña · últimos 30 días</p>
            {porCampana.some((c) => Number(c.fallidos) > 0) && (
              <p className="text-xs text-vivo">
                Un envío fallido no se reintenta: ese lead se ha perdido.
              </p>
            )}
          </div>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-linea text-left">
                <th className="pb-1 font-normal text-tenue">Campaña</th>
                <th className="pb-1 font-normal text-tenue">Cuenta</th>
                <th className="pb-1 text-right font-normal text-tenue">
                  Enviados
                </th>
                <th className="pb-1 text-right font-normal text-tenue">
                  Borradores
                </th>
                <th className="pb-1 text-right font-normal text-tenue">
                  Fallidos
                </th>
              </tr>
            </thead>
            <tbody>
              {porCampana.map((c) => (
                <tr
                  key={c.campana}
                  className="border-b border-linea last:border-0"
                >
                  <td className="py-1.5">
                    {c.campana}
                    {c.estado !== "running" && (
                      <span className="ml-2 text-xs text-aviso">
                        {c.estado}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 text-tenue">
                    {c.cuenta ?? "sin cuenta"}
                  </td>
                  <td className="py-1.5 text-right font-mono">
                    {Number(c.enviados)}
                  </td>
                  <td className="py-1.5 text-right font-mono text-ensayo">
                    {Number(c.borradores) || ""}
                  </td>
                  <td
                    className={`py-1.5 text-right font-mono ${Number(c.fallidos) ? "font-bold text-vivo" : "text-tenue"}`}
                  >
                    {Number(c.fallidos) || ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="border border-linea bg-lienzo p-4">
          <h2 className="etiqueta">Embudo</h2>
          <ul className="mt-3 space-y-2">
            {EMBUDO.map(({ estado, etiqueta }) => {
              const n = conteo.get(estado) ?? 0;
              return (
                <li
                  key={estado}
                  className="grid grid-cols-[9rem_1fr_3rem] items-center gap-3"
                >
                  <Link
                    href={`/leads?estado=${estado}`}
                    className="text-sm text-apagado hover:text-tinta"
                  >
                    {etiqueta}
                  </Link>
                  <span className="h-5 bg-papel">
                    <span
                      className="block h-full bg-ensayo"
                      style={{ width: `${(n / maximo) * 100}%` }}
                    />
                  </span>
                  <span className="text-right font-mono text-sm">{n}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="border border-linea bg-lienzo p-4">
          <h2 className="etiqueta">Salidas</h2>
          <ul className="mt-3 space-y-2">
            {SALIDAS.map(({ estado, etiqueta }) => (
              <li key={estado} className="flex items-center justify-between">
                <Link
                  href={`/leads?estado=${estado}`}
                  className="text-sm text-apagado hover:text-tinta"
                >
                  {etiqueta}
                </Link>
                <span
                  className={`font-mono text-sm ${estado === "revision_humana" && (conteo.get(estado) ?? 0) > 0 ? "text-aviso" : ""}`}
                >
                  {conteo.get(estado) ?? 0}
                </span>
              </li>
            ))}
          </ul>
          {(conteo.get("revision_humana") ?? 0) > 0 && (
            <p className="mt-4 border-l-2 border-aviso bg-papel px-3 py-2 text-xs text-aviso">
              Hay leads esperándote. El agente no los va a tocar.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
