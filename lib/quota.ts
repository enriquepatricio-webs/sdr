/**
 * Cupo de envío.
 *
 * Cuántos mensajes puede sacar una cuenta AHORA MISMO. Es función pura y está
 * separada del route handler a propósito: es la regla que impide que te
 * bloqueen una cuenta, y tiene que poder demostrarse con pruebas en vez de
 * confiarse.
 *
 * Regla que no se negocia: el número de leads disponibles NO entra en este
 * cálculo. Tener diez mil leads en la cola no da derecho a un mensaje más que
 * tener diez. Lo único que decide es el tope de la cuenta, el de la campaña y
 * lo que ya ha salido hoy.
 */

export type MotivoSinCupo =
  | 'tope_diario_cuenta'
  | 'tope_diario_campana'
  | 'tope_horario'
  /** Hay cupo, pero todavía no toca: se está repartiendo a lo largo del día. */
  | 'ritmo'

export type Cupo =
  | {
      hay: true
      cuantos: number
      limitadoPor: 'cuenta' | 'campana' | 'hora' | 'ritmo' | 'lote'
    }
  | { hay: false; motivo: MotivoSinCupo; detalle: string }

export type EntradaCupo = {
  /** Tope diario de la cuenta. Manda sobre TODAS sus campañas. */
  topeDiarioCuenta: number
  /** Tope diario de esta campaña. Solo sobre la suya. */
  topeDiarioCampana: number
  /** Tope por hora, o null si la plataforma no lo necesita. */
  topeHorarioCuenta: number | null
  /** Enviados hoy por la CUENTA, sumando todas sus campañas. */
  enviadosHoyCuenta: number
  /** Enviados hoy por esta campaña. */
  enviadosHoyCampana: number
  /** Enviados en la hora en curso por la cuenta. */
  enviadosEstaHoraCuenta: number
  /** Tamaño máximo del lote que pide quien llama. */
  lote: number
  /**
   * Qué parte de la ventana de envío ha pasado ya, de 0 a 1.
   *
   * Es lo que reparte el cupo del día a lo largo del día. A media mañana solo
   * está autorizada la mitad de los envíos, aunque el tope diario entero siga
   * libre. Sin esto los veinte correos salían en la primera hora, que es lo que
   * un desconocido percibe como un envío masivo.
   */
  fraccionDeVentana?: number
}

/**
 * Cuánto tiempo un borrador reserva su hueco de cupo.
 *
 * Los dos caminos que envían por Instagram —la campaña en frío y el imán—
 * cuentan cada uno por su lado, y ninguno veía lo que el otro estaba a punto de
 * mandar: los dos creían tener los 8 de la hora enteros y entre los dos podían
 * sacar 16, que es por encima del límite de Instagram y camino directo al
 * bloqueo de la cuenta.
 *
 * Como los dos ESCRIBEN el toque en 'borrador' antes de enviar, contar los
 * borradores recientes convierte ese registro en una reserva sin añadir ninguna
 * pieza nueva. Cinco minutos porque el envío ocurre en segundos: un borrador más
 * viejo es uno que no salió (autopiloto apagado o fallo), y ese no debe seguir
 * ocupando sitio para siempre.
 */
export const MINUTOS_QUE_RESERVA_UN_BORRADOR = 5

export function calcularCupo(e: EntradaCupo): Cupo {
  const quedaCuenta = e.topeDiarioCuenta - e.enviadosHoyCuenta
  if (quedaCuenta <= 0) {
    return {
      hay: false,
      motivo: 'tope_diario_cuenta',
      detalle: `${e.enviadosHoyCuenta}/${e.topeDiarioCuenta} hoy en esta cuenta`,
    }
  }

  const quedaCampana = e.topeDiarioCampana - e.enviadosHoyCampana
  if (quedaCampana <= 0) {
    return {
      hay: false,
      motivo: 'tope_diario_campana',
      detalle: `${e.enviadosHoyCampana}/${e.topeDiarioCampana} hoy en esta campaña`,
    }
  }

  let quedaHora = Number.POSITIVE_INFINITY
  if (e.topeHorarioCuenta !== null) {
    quedaHora = e.topeHorarioCuenta - e.enviadosEstaHoraCuenta
    if (quedaHora <= 0) {
      return {
        hay: false,
        motivo: 'tope_horario',
        detalle: `${e.enviadosEstaHoraCuenta}/${e.topeHorarioCuenta} en la hora en curso`,
      }
    }
  }

  /**
   * El ritmo: cuántos DEBERÍAN haber salido ya a estas horas.
   *
   * Es lo que convierte "veinte al día" en veinte repartidos, y no veinte
   * seguidos en cuanto abre la ventana. A mitad de la ventana están autorizados
   * la mitad; si ya se han mandado esos, se espera aunque el tope diario tenga
   * sitio de sobra.
   *
   * Se redondea hacia arriba y con un mínimo de uno para que a primera hora se
   * pueda empezar: con el redondeo hacia abajo, a las 09:05 el permitido sería
   * cero y la campaña no arrancaría nunca.
   */
  let quedaRitmo = Number.POSITIVE_INFINITY
  if (e.fraccionDeVentana !== undefined) {
    const permitidoAhora = Math.max(1, Math.ceil(e.topeDiarioCampana * e.fraccionDeVentana))
    quedaRitmo = permitidoAhora - e.enviadosHoyCampana
    if (quedaRitmo <= 0) {
      return {
        hay: false,
        motivo: 'ritmo',
        detalle: `${e.enviadosHoyCampana} enviados y a estas horas tocan ${permitidoAhora}; se reparte el resto durante el día`,
      }
    }
  }

  const candidatos = [
    { n: quedaCuenta, quien: 'cuenta' as const },
    { n: quedaCampana, quien: 'campana' as const },
    { n: quedaHora, quien: 'hora' as const },
    { n: quedaRitmo, quien: 'ritmo' as const },
    { n: e.lote, quien: 'lote' as const },
  ]
  const menor = candidatos.reduce((a, b) => (b.n < a.n ? b : a))

  return { hay: true, cuantos: menor.n, limitadoPor: menor.quien }
}
