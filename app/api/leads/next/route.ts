import { NextResponse } from "next/server";
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  campaigns,
  leads,
  touches,
  workspaces,
} from "@/lib/db/schema";
import { serverError } from "@/lib/api";
import {
  fraccionDeVentana,
  fueraDeVentana,
  inicioDeLaHoraLocal,
  inicioDelDiaLocal,
  proximaApertura,
} from "@/lib/sending-window";
import { MINUTOS_QUE_RESERVA_UN_BORRADOR, calcularCupo } from "@/lib/quota";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * La cola de trabajo del agente. Es el punto donde vive el control de riesgo.
 *
 * La decisión de si se puede enviar se toma AQUÍ y no en n8n, a propósito: un
 * workflow se edita en un panel web sin revisión ni pruebas, y el precio de
 * equivocarse es una cuenta de LinkedIn bloqueada o un prospecto recibiendo
 * cinco mensajes. Si esta ruta devuelve una lista vacía, no hay forma de que
 * n8n envíe nada.
 *
 * Devuelve además POR QUÉ está vacía y cuándo volver a preguntar: un array
 * vacío sin explicación es imposible de depurar a las tres de la mañana.
 */

/**
 * Cuánto se reserva un lead al entregarlo. Tiene que cubrir de sobra lo que
 * tarda W1 en llegar a él dentro de su propio lote (25 leads x 180 s = 75 min)
 * y quedarse corto frente a cualquier reintento razonable.
 */
const MINUTOS_DE_RESERVA = 90;

type Motivo =
  | "campana_pausada"
  | "sin_cuenta"
  | "cuenta_inactiva"
  | "cuenta_frenada"
  | "fuera_de_ventana"
  | "tope_diario_cuenta"
  | "tope_diario_campana"
  | "tope_horario"
  | "ritmo"
  | "sin_leads_pendientes";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const campaignId = url.searchParams.get("campaign_id");
  const modo =
    url.searchParams.get("mode") === "seguimiento"
      ? "seguimiento"
      : "primer_toque";
  const limite = Math.min(Number(url.searchParams.get("limit")) || 25, 100);
  const ahora = new Date();

  try {
    const ajustes = await getSettings();

    const filas = await db
      .select({ campana: campaigns, cuenta: accounts, empresa: workspaces })
      .from(campaigns)
      .leftJoin(accounts, eq(campaigns.accountId, accounts.id))
      .leftJoin(workspaces, eq(campaigns.workspaceId, workspaces.id))
      /**
       * Primero la campaña que lleva más tiempo sin enviar nada.
       *
       * El lote es de 25 y las campañas se recorren en orden. Sin criterio, las
       * mismas iban siempre delante y se llevaban el lote entero: con ocho
       * campañas repartidas entre dos empresas, la última de la lista podía no
       * enviar nunca. Servir a quien lleva más esperando reparte solo.
       */
      .orderBy(
        sql`(select max(t.sent_at) from touches t
             join leads l on l.id = t.lead_id
             where l.campaign_id = ${campaigns.id} and t.status = 'enviado') asc nulls first`,
      )
      .where(
        campaignId
          ? eq(campaigns.id, campaignId)
          : eq(campaigns.status, "running"),
      );

    /**
     * Cada lead viaja con su empresa. n8n la necesita para pedir el playbook
     * correcto y para decir de parte de quién escribe; el autopiloto en cambio
     * no se decide aquí, sino en /api/messages/send, que es la única puerta de
     * salida y la aplica leyendo la empresa de la campaña.
     */
    const seleccionados: (typeof leads.$inferSelect & {
      workspaceId: string | null;
      empresa: string | null;
    })[] = [];
    const descartadas: {
      campana: string;
      nombre: string;
      motivo: Motivo;
      detalle?: string;
    }[] = [];
    const reintentos: Date[] = [];
    /**
     * Lo que ya se ha repartido POR CUENTA en esta misma respuesta.
     *
     * Los conteos salen de la base de datos y no cambian mientras se recorre el
     * bucle, así que dos campañas sobre la misma cuenta veían cada una el cupo
     * restante entero y entre las dos lo duplicaban. Con topes de 20 al día,
     * dos campañas devolvían 40 leads.
     */
    const repartidoPorCuenta = new Map<string, number>();

    for (const { campana, cuenta, empresa } of filas) {
      const descartar = (motivo: Motivo, detalle?: string) =>
        descartadas.push({
          campana: campana.id,
          nombre: campana.name,
          motivo,
          detalle,
        });

      // 1. El interruptor de parada actúa aquí: pausar la campaña vacía la cola.
      if (campana.status !== "running") {
        descartar("campana_pausada");
        continue;
      }
      if (!cuenta) {
        descartar("sin_cuenta");
        continue;
      }
      if (cuenta.status !== "active") {
        descartar("cuenta_inactiva", `la cuenta está en "${cuenta.status}"`);
        continue;
      }

      /**
       * El proveedor ha frenado la cuenta y todavía no la ha soltado.
       *
       * Sin esto, el tope de LinkedIn se descubría lead a lead: cada uno salía
       * de la cola, se redactaba con el modelo, se intentaba enviar y volvía
       * con el mismo error. Veinte veces al día, y ni un mensaje entregado.
       */
      if (cuenta.throttledUntil && cuenta.throttledUntil > ahora) {
        reintentos.push(cuenta.throttledUntil);
        descartar(
          "cuenta_frenada",
          `${cuenta.displayName} ha llegado al tope del proveedor; vuelve el ${cuenta.throttledUntil.toISOString()}`,
        );
        continue;
      }

      // 2. Ventana de envío, en la zona horaria del prospecto.
      const fuera = fueraDeVentana(campana.sendingWindow, ahora);
      if (fuera) {
        const apertura = proximaApertura(campana.sendingWindow, ahora);
        reintentos.push(apertura);
        descartar(
          "fuera_de_ventana",
          `${fuera}; abre el ${apertura.toISOString()}`,
        );
        continue;
      }

      // 3. Cuota. Se cuenta sobre `sent_at`, no sobre `created_at`: un borrador
      //    redactado el lunes y aprobado el jueves consume la cuota del jueves.
      const inicioDia = inicioDelDiaLocal(campana.sendingWindow.tz, ahora);
      const inicioHora = inicioDeLaHoraLocal(campana.sendingWindow.tz, ahora);

      // Un borrador escrito hace menos de cinco minutos cuenta como enviado.
      // Es la reserva que impide que dos procesos —esta cola y el ciclo de un
      // imán sobre la misma cuenta de Instagram— se gasten el mismo hueco.
      const desdeReserva = new Date(
        ahora.getTime() - MINUTOS_QUE_RESERVA_UN_BORRADOR * 60_000,
      );
      const reservado = sql`(${touches.status} = 'borrador' and ${touches.createdAt} >= ${desdeReserva})`;
      const enviadoHoy = sql`(${touches.status} = 'enviado' and ${touches.sentAt} >= ${inicioDia})`;
      const enviadoAhora = sql`(${touches.status} = 'enviado' and ${touches.sentAt} >= ${inicioHora})`;

      const [conteo] = await db
        .select({
          diaCuenta: count(),
          diaCampana: sql<number>`count(*) filter (where ${leads.campaignId} = ${campana.id}::uuid)::int`,
          hora: sql<number>`count(*) filter (where ${enviadoAhora} or ${reservado})::int`,
        })
        .from(touches)
        .innerJoin(leads, eq(touches.leadId, leads.id))
        .where(
          and(
            eq(touches.accountId, cuenta.id),
            eq(touches.direction, "out"),
            sql`(${enviadoHoy} or ${reservado})`,
          ),
        );

      // El cálculo vive en lib/quota.ts, aparte y con sus propias pruebas: es la
      // regla que impide que bloqueen la cuenta, y no puede depender de cuántos
      // leads haya esperando. Con el reabastecimiento automático encendido la
      // cola nunca se vacía, así que esto es lo único que frena el volumen.
      const yaRepartido = repartidoPorCuenta.get(cuenta.id) ?? 0;

      const cupo = calcularCupo({
        topeDiarioCuenta: cuenta.dailyLimit,
        topeDiarioCampana: campana.dailyCap,
        topeHorarioCuenta: cuenta.hourlyLimit,
        enviadosHoyCuenta: Number(conteo?.diaCuenta ?? 0) + yaRepartido,
        enviadosHoyCampana: Number(conteo?.diaCampana ?? 0),
        enviadosEstaHoraCuenta: Number(conteo?.hora ?? 0) + yaRepartido,
        // Reparte el cupo del día a lo largo de la ventana en vez de gastarlo
        // entero en la primera hora.
        fraccionDeVentana: fraccionDeVentana(campana.sendingWindow, ahora),
        lote: limite - seleccionados.length,
      });

      if (!cupo.hay) {
        reintentos.push(
          cupo.motivo === "ritmo"
            ? // El ritmo se libera solo con el paso del tiempo: basta con volver
              // en la siguiente vuelta del cron.
              new Date(ahora.getTime() + 15 * 60_000)
            : cupo.motivo === "tope_horario"
              ? new Date(inicioHora.getTime() + 3600_000)
              : proximaApertura(campana.sendingWindow, ahora),
        );
        descartar(cupo.motivo, cupo.detalle);
        continue;
      }

      const disponibles = cupo.cuantos;

      // 4. Leads que tocan según el modo.
      const condiciones =
        modo === "primer_toque"
          ? and(
              eq(leads.campaignId, campana.id),
              eq(leads.status, "nuevo"),
              or(isNull(leads.nextActionAt), lte(leads.nextActionAt, ahora)),
            )
          : and(
              eq(leads.campaignId, campana.id),
              inArray(leads.status, ["contactado", "en_seguimiento"]),
              lte(leads.nextActionAt, ahora),
              sql`${leads.touchCount} < ${campana.maxTouches}`,
            );

      /**
       * Se RESERVAN, no se leen.
       *
       * W1 corre cada 30 minutos y tarda hasta 75 (25 leads con esperas de
       * 40-180 s), así que dos ejecuciones se solapan casi siempre. Con un
       * SELECT, las dos se llevaban el mismo lote y el prospecto recibía dos
       * primeros toques: el fallo más caro del sistema, porque la única persona
       * que se entera es la que lo recibe.
       *
       * `for update skip locked` hace que dos llamadas simultáneas cojan
       * conjuntos disjuntos, y mover `next_action_at` al futuro convierte esa
       * exclusión en algo que sobrevive a la transacción. Si el workflow se cae
       * antes de enviar, la reserva caduca sola y el lead vuelve a la cola.
       */
      const lote = await db
        .update(leads)
        .set({
          nextActionAt: new Date(ahora.getTime() + MINUTOS_DE_RESERVA * 60_000),
        })
        .where(
          inArray(
            leads.id,
            db
              .select({ id: leads.id })
              .from(leads)
              .where(condiciones)
              .orderBy(asc(leads.nextActionAt), asc(leads.createdAt))
              .limit(disponibles)
              .for("update", { skipLocked: true }),
          ),
        )
        .returning();

      if (!lote.length) descartar("sin_leads_pendientes");
      repartidoPorCuenta.set(cuenta.id, yaRepartido + lote.length);
      seleccionados.push(
        ...lote.map((l) => ({
          ...l,
          workspaceId: campana.workspaceId,
          empresa: empresa?.name ?? null,
        })),
      );

      if (seleccionados.length >= limite) break;
    }

    return NextResponse.json({
      modo,
      modelo: ajustes.openrouterModel,
      // El autopiloto es de cada empresa. Se informa de cuál está encendida para
      // poder mirarlo de un vistazo, pero quien lo aplica es /api/messages/send.
      empresas: [
        ...new Map(
          filas
            .filter((f) => f.empresa)
            .map((f) => [f.empresa!.id, f.empresa!]),
        ).values(),
      ].map((e) => ({ id: e.id, nombre: e.name, autopilot: e.autopilot })),
      leads: seleccionados.slice(0, limite),
      // Sin esto, "no ha salido nada" es indistinguible de "está roto".
      descartadas,
      proximaRevision: reintentos.length
        ? new Date(
            Math.min(...reintentos.map((d) => d.getTime())),
          ).toISOString()
        : null,
    });
  } catch (err) {
    return serverError(err, "No se pudo calcular la cola de envío");
  }
}
