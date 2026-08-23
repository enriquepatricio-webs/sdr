/**
 * Ventanas de envío y husos horarios.
 *
 * Esto decide si el agente puede escribir AHORA y cuánta cuota le queda hoy.
 * Vive aparte y con sus propias pruebas porque un fallo aquí no da un error:
 * da mensajes a las 4 de la mañana, o el doble del tope diario, o una cuenta
 * de LinkedIn bloqueada. Se usa Intl y no una librería de fechas porque la
 * conversión que hace falta ya está en la plataforma.
 */
import type { SendingWindow } from './db/schema'

export type PartesLocales = {
  /** Fecha civil en la zona, YYYY-MM-DD. */
  fecha: string
  /** Minutos desde medianoche local. */
  minutos: number
  /** Día de la semana ISO: 1 = lunes … 7 = domingo. */
  diaSemana: number
}

/** Desfase de la zona respecto a UTC, en minutos, en ese instante concreto. */
export function offsetMinutos(tz: string, en: Date): number {
  const nombre = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(en)
    .find((p) => p.type === 'timeZoneName')?.value

  // "GMT+02:00", "GMT-05:00" o "GMT" a secas en UTC.
  const m = nombre?.match(/GMT([+-])(\d{2}):(\d{2})/)
  if (!m) return 0
  const signo = m[1] === '-' ? -1 : 1
  return signo * (Number(m[2]) * 60 + Number(m[3]))
}

export function partesLocales(tz: string, ahora: Date): PartesLocales {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(ahora)
      .map((p) => [p.type, p.value]),
  )

  const fecha = `${partes.year}-${partes.month}-${partes.day}`
  // El día de la semana sale de la fecha civil, que no depende del huso.
  const dow = new Date(`${fecha}T00:00:00Z`).getUTCDay()

  return {
    fecha,
    minutos: Number(partes.hour) * 60 + Number(partes.minute),
    diaSemana: dow === 0 ? 7 : dow,
  }
}

function aMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + (m || 0)
}

/**
 * Instante UTC que corresponde a una hora civil de esa zona.
 *
 * Se itera dos veces porque el desfase que aplica es el del instante buscado,
 * no el de ahora: en el día del cambio de hora la primera estimación se va
 * sesenta minutos. Dos pasadas convergen salvo en la hora ambigua del cambio.
 */
export function instanteLocal(tz: string, fecha: string, hhmm: string): Date {
  const comoSiFueraUtc = Date.parse(`${fecha}T${hhmm.padStart(5, '0')}:00Z`)
  let instante = new Date(comoSiFueraUtc)
  for (let i = 0; i < 2; i++) {
    instante = new Date(comoSiFueraUtc - offsetMinutos(tz, instante) * 60000)
  }
  return instante
}

export type MotivoFuera = 'dia_no_habil' | 'antes_de_abrir' | 'despues_de_cerrar' | null

/** Por qué no se puede enviar ahora, o null si sí se puede. */
export function fueraDeVentana(ventana: SendingWindow, ahora: Date): MotivoFuera {
  const { minutos, diaSemana } = partesLocales(ventana.tz, ahora)
  if (!ventana.days.includes(diaSemana)) return 'dia_no_habil'
  if (minutos < aMinutos(ventana.from)) return 'antes_de_abrir'
  if (minutos >= aMinutos(ventana.to)) return 'despues_de_cerrar'
  return null
}

export function dentroDeVentana(ventana: SendingWindow, ahora: Date): boolean {
  return fueraDeVentana(ventana, ahora) === null
}

/**
 * Instante en que empezó el día en esa zona.
 *
 * El tope es "por día", y el día es el del prospecto, no el del servidor: un
 * servidor en UTC cambiaría de día a la una de la madrugada en Madrid y
 * regalaría una cuota entera a mitad de la noche.
 */
export function inicioDelDiaLocal(tz: string, ahora: Date): Date {
  return instanteLocal(tz, partesLocales(tz, ahora).fecha, '00:00')
}

/** Instante en que empezó la hora en curso. Para el tope horario de Instagram. */
export function inicioDeLaHoraLocal(tz: string, ahora: Date): Date {
  const { fecha, minutos } = partesLocales(tz, ahora)
  const hora = String(Math.floor(minutos / 60)).padStart(2, '0')
  return instanteLocal(tz, fecha, `${hora}:00`)
}

/** Cuándo vuelve a abrir la ventana. Sirve para decirle a n8n cuándo volver. */
export function proximaApertura(ventana: SendingWindow, ahora: Date): Date {
  const { fecha, minutos, diaSemana } = partesLocales(ventana.tz, ahora)

  if (ventana.days.includes(diaSemana) && minutos < aMinutos(ventana.from)) {
    return instanteLocal(ventana.tz, fecha, ventana.from)
  }

  // Se avanza día a día sobre la fecha civil hasta dar con uno hábil.
  for (let salto = 1; salto <= 7; salto++) {
    const dia = new Date(`${fecha}T00:00:00Z`)
    dia.setUTCDate(dia.getUTCDate() + salto)
    const iso = dia.toISOString().slice(0, 10)
    const dow = dia.getUTCDay() === 0 ? 7 : dia.getUTCDay()
    if (ventana.days.includes(dow)) return instanteLocal(ventana.tz, iso, ventana.from)
  }

  // Una ventana sin ningún día hábil no abre nunca; se devuelve lejos.
  return new Date(ahora.getTime() + 7 * 24 * 3600_000)
}
