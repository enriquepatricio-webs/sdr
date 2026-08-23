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

export type MotivoSinCupo = 'tope_diario_cuenta' | 'tope_diario_campana' | 'tope_horario'

export type Cupo =
  | { hay: true; cuantos: number; limitadoPor: 'cuenta' | 'campana' | 'hora' | 'lote' }
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
}

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

  const candidatos = [
    { n: quedaCuenta, quien: 'cuenta' as const },
    { n: quedaCampana, quien: 'campana' as const },
    { n: quedaHora, quien: 'hora' as const },
    { n: e.lote, quien: 'lote' as const },
  ]
  const menor = candidatos.reduce((a, b) => (b.n < a.n ? b : a))

  return { hay: true, cuantos: menor.n, limitadoPor: menor.quien }
}
