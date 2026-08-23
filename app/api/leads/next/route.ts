import { NextResponse } from 'next/server'
import { and, asc, count, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { accounts, campaigns, leads, touches } from '@/lib/db/schema'
import { serverError } from '@/lib/api'
import {
  fueraDeVentana,
  inicioDeLaHoraLocal,
  inicioDelDiaLocal,
  proximaApertura,
} from '@/lib/sending-window'
import { calcularCupo } from '@/lib/quota'
import { getSettings } from '@/lib/settings'

export const dynamic = 'force-dynamic'

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

type Motivo =
  | 'campana_pausada'
  | 'sin_cuenta'
  | 'cuenta_inactiva'
  | 'fuera_de_ventana'
  | 'tope_diario_cuenta'
  | 'tope_diario_campana'
  | 'tope_horario'
  | 'sin_leads_pendientes'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const campaignId = url.searchParams.get('campaign_id')
  const modo = url.searchParams.get('mode') === 'seguimiento' ? 'seguimiento' : 'primer_toque'
  const limite = Math.min(Number(url.searchParams.get('limit')) || 25, 100)
  const ahora = new Date()

  try {
    const ajustes = await getSettings()

    const filas = await db
      .select({ campana: campaigns, cuenta: accounts })
      .from(campaigns)
      .leftJoin(accounts, eq(campaigns.accountId, accounts.id))
      .where(campaignId ? eq(campaigns.id, campaignId) : eq(campaigns.status, 'running'))

    const seleccionados: (typeof leads.$inferSelect)[] = []
    const descartadas: { campana: string; nombre: string; motivo: Motivo; detalle?: string }[] = []
    const reintentos: Date[] = []

    for (const { campana, cuenta } of filas) {
      const descartar = (motivo: Motivo, detalle?: string) =>
        descartadas.push({ campana: campana.id, nombre: campana.name, motivo, detalle })

      // 1. El interruptor de parada actúa aquí: pausar la campaña vacía la cola.
      if (campana.status !== 'running') {
        descartar('campana_pausada')
        continue
      }
      if (!cuenta) {
        descartar('sin_cuenta')
        continue
      }
      if (cuenta.status !== 'active') {
        descartar('cuenta_inactiva', `la cuenta está en "${cuenta.status}"`)
        continue
      }

      // 2. Ventana de envío, en la zona horaria del prospecto.
      const fuera = fueraDeVentana(campana.sendingWindow, ahora)
      if (fuera) {
        const apertura = proximaApertura(campana.sendingWindow, ahora)
        reintentos.push(apertura)
        descartar('fuera_de_ventana', `${fuera}; abre el ${apertura.toISOString()}`)
        continue
      }

      // 3. Cuota. Se cuenta sobre `sent_at`, no sobre `created_at`: un borrador
      //    redactado el lunes y aprobado el jueves consume la cuota del jueves.
      const inicioDia = inicioDelDiaLocal(campana.sendingWindow.tz, ahora)
      const inicioHora = inicioDeLaHoraLocal(campana.sendingWindow.tz, ahora)

      const [conteo] = await db
        .select({
          diaCuenta: count(),
          diaCampana: sql<number>`count(*) filter (where ${leads.campaignId} = ${campana.id}::uuid)::int`,
          hora: sql<number>`count(*) filter (where ${touches.sentAt} >= ${inicioHora})::int`,
        })
        .from(touches)
        .innerJoin(leads, eq(touches.leadId, leads.id))
        .where(
          and(
            eq(touches.accountId, cuenta.id),
            eq(touches.direction, 'out'),
            eq(touches.status, 'enviado'),
            gte(touches.sentAt, inicioDia),
          ),
        )

      // El cálculo vive en lib/quota.ts, aparte y con sus propias pruebas: es la
      // regla que impide que bloqueen la cuenta, y no puede depender de cuántos
      // leads haya esperando. Con el reabastecimiento automático encendido la
      // cola nunca se vacía, así que esto es lo único que frena el volumen.
      const cupo = calcularCupo({
        topeDiarioCuenta: cuenta.dailyLimit,
        topeDiarioCampana: campana.dailyCap,
        topeHorarioCuenta: cuenta.hourlyLimit,
        enviadosHoyCuenta: Number(conteo?.diaCuenta ?? 0),
        enviadosHoyCampana: Number(conteo?.diaCampana ?? 0),
        enviadosEstaHoraCuenta: Number(conteo?.hora ?? 0),
        lote: limite - seleccionados.length,
      })

      if (!cupo.hay) {
        reintentos.push(
          cupo.motivo === 'tope_horario'
            ? new Date(inicioHora.getTime() + 3600_000)
            : proximaApertura(campana.sendingWindow, ahora),
        )
        descartar(cupo.motivo, cupo.detalle)
        continue
      }

      const disponibles = cupo.cuantos

      // 4. Leads que tocan según el modo.
      const condiciones =
        modo === 'primer_toque'
          ? and(
              eq(leads.campaignId, campana.id),
              eq(leads.status, 'nuevo'),
              or(isNull(leads.nextActionAt), lte(leads.nextActionAt, ahora)),
            )
          : and(
              eq(leads.campaignId, campana.id),
              inArray(leads.status, ['contactado', 'en_seguimiento']),
              lte(leads.nextActionAt, ahora),
              sql`${leads.touchCount} < ${campana.maxTouches}`,
            )

      const lote = await db
        .select()
        .from(leads)
        .where(condiciones)
        .orderBy(asc(leads.nextActionAt), asc(leads.createdAt))
        .limit(disponibles)

      if (!lote.length) descartar('sin_leads_pendientes')
      seleccionados.push(...lote)

      if (seleccionados.length >= limite) break
    }

    return NextResponse.json({
      modo,
      autopilot: ajustes.autopilot,
      modelo: ajustes.openrouterModel,
      leads: seleccionados.slice(0, limite),
      // Sin esto, "no ha salido nada" es indistinguible de "está roto".
      descartadas,
      proximaRevision: reintentos.length
        ? new Date(Math.min(...reintentos.map((d) => d.getTime()))).toISOString()
        : null,
    })
  } catch (err) {
    return serverError(err, 'No se pudo calcular la cola de envío')
  }
}
