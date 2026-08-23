/**
 * Pruebas de la ventana de envío. `npm run test:ventana`.
 *
 * Se prueba con fechas reales de cambio de hora porque es donde falla este tipo
 * de código, y falla en silencio: no da error, da mensajes a deshora o el doble
 * de la cuota diaria.
 */
import assert from 'node:assert/strict'
import type { SendingWindow } from './db/schema'
import {
  dentroDeVentana,
  fueraDeVentana,
  inicioDeLaHoraLocal,
  inicioDelDiaLocal,
  instanteLocal,
  offsetMinutos,
  partesLocales,
  proximaApertura,
} from './sending-window'

let ok = 0
const fallos: string[] = []

function prueba(nombre: string, fn: () => void) {
  try {
    fn()
    ok++
  } catch (err) {
    fallos.push(`${nombre}\n    ${(err as Error).message.split('\n')[0]}`)
  }
}

const MADRID: SendingWindow = {
  tz: 'Europe/Madrid',
  from: '09:00',
  to: '18:00',
  days: [1, 2, 3, 4, 5],
}

/* ---- Desfases y horario de verano ------------------------------------- */

prueba('Madrid en invierno va a +1', () =>
  assert.equal(offsetMinutos('Europe/Madrid', new Date('2026-01-15T12:00:00Z')), 60),
)
prueba('Madrid en verano va a +2', () =>
  assert.equal(offsetMinutos('Europe/Madrid', new Date('2026-07-15T12:00:00Z')), 120),
)
prueba('Ciudad de México va en negativo', () =>
  assert.equal(offsetMinutos('America/Mexico_City', new Date('2026-07-15T12:00:00Z')), -360),
)

/* ---- Hora local -------------------------------------------------------- */

prueba('las 12:00 UTC de julio son las 14:00 en Madrid', () => {
  const p = partesLocales('Europe/Madrid', new Date('2026-07-15T12:00:00Z'))
  assert.equal(p.minutos, 14 * 60)
  assert.equal(p.fecha, '2026-07-15')
})

prueba('a las 23:30 UTC en Madrid ya es el día siguiente', () => {
  const p = partesLocales('Europe/Madrid', new Date('2026-07-15T23:30:00Z'))
  assert.equal(p.fecha, '2026-07-16')
  assert.equal(p.minutos, 90)
})

prueba('el lunes es 1 y el domingo es 7', () => {
  assert.equal(partesLocales('Europe/Madrid', new Date('2026-08-17T10:00:00Z')).diaSemana, 1)
  assert.equal(partesLocales('Europe/Madrid', new Date('2026-08-23T10:00:00Z')).diaSemana, 7)
})

/* ---- Dentro y fuera de la ventana -------------------------------------- */

prueba('lunes a las 12:00 de Madrid: dentro', () =>
  assert.equal(dentroDeVentana(MADRID, new Date('2026-08-17T10:00:00Z')), true),
)
prueba('lunes a las 08:00 de Madrid: demasiado pronto', () =>
  assert.equal(fueraDeVentana(MADRID, new Date('2026-08-17T06:00:00Z')), 'antes_de_abrir'),
)
prueba('lunes a las 18:00 en punto: ya cerrado', () =>
  assert.equal(fueraDeVentana(MADRID, new Date('2026-08-17T16:00:00Z')), 'despues_de_cerrar'),
)
prueba('lunes a las 17:59: todavía abierto', () =>
  assert.equal(fueraDeVentana(MADRID, new Date('2026-08-17T15:59:00Z')), null),
)
prueba('sábado a mediodía: día no hábil', () =>
  assert.equal(fueraDeVentana(MADRID, new Date('2026-08-22T10:00:00Z')), 'dia_no_habil'),
)

prueba('la misma hora UTC cae dentro en invierno y fuera en verano', () => {
  // 07:30 UTC = 08:30 en Madrid (invierno, cerrado) y 09:30 (verano, abierto).
  assert.equal(dentroDeVentana(MADRID, new Date('2026-01-19T07:30:00Z')), false)
  assert.equal(dentroDeVentana(MADRID, new Date('2026-07-13T07:30:00Z')), true)
})

/* ---- Inicio del día local ---------------------------------------------- */

prueba('el día en Madrid empieza a las 22:00 UTC del día antes (verano)', () =>
  assert.equal(
    inicioDelDiaLocal('Europe/Madrid', new Date('2026-07-15T12:00:00Z')).toISOString(),
    '2026-07-14T22:00:00.000Z',
  ),
)
prueba('y a las 23:00 UTC en invierno', () =>
  assert.equal(
    inicioDelDiaLocal('Europe/Madrid', new Date('2026-01-15T12:00:00Z')).toISOString(),
    '2026-01-14T23:00:00.000Z',
  ),
)

/* El día en que se adelanta el reloj: medianoche todavía es horario de invierno. */
prueba('adelanto de hora (29-mar-2026): el día empieza en +1, no en +2', () =>
  assert.equal(
    inicioDelDiaLocal('Europe/Madrid', new Date('2026-03-29T12:00:00Z')).toISOString(),
    '2026-03-28T23:00:00.000Z',
  ),
)
/* El día en que se atrasa: medianoche todavía es horario de verano. */
prueba('atraso de hora (25-oct-2026): el día empieza en +2, no en +1', () =>
  assert.equal(
    inicioDelDiaLocal('Europe/Madrid', new Date('2026-10-25T12:00:00Z')).toISOString(),
    '2026-10-24T22:00:00.000Z',
  ),
)

prueba('la cuota diaria no se duplica en el día del cambio de hora', () => {
  // Si el inicio del día se calculase con el desfase de "ahora" en vez del de
  // medianoche, la ventana contada duraría 25 h y el tope se iría un 4%.
  const enElCambio = new Date('2026-10-25T14:00:00Z')
  const inicio = inicioDelDiaLocal('Europe/Madrid', enElCambio)
  const horas = (enElCambio.getTime() - inicio.getTime()) / 3600_000
  assert.ok(horas > 0 && horas < 24, `salieron ${horas} h de día transcurrido`)
})

/* ---- Inicio de la hora en curso ---------------------------------------- */

prueba('la hora en curso se corta en el minuto 0', () =>
  assert.equal(
    inicioDeLaHoraLocal('Europe/Madrid', new Date('2026-07-15T12:37:41Z')).toISOString(),
    '2026-07-15T12:00:00.000Z',
  ),
)

/* ---- Ida y vuelta ------------------------------------------------------- */

prueba('instanteLocal y partesLocales son inversas', () => {
  for (const [fecha, hora] of [
    ['2026-01-15', '09:00'],
    ['2026-07-15', '09:00'],
    ['2026-03-29', '09:00'],
    ['2026-10-25', '09:00'],
  ] as const) {
    const p = partesLocales('Europe/Madrid', instanteLocal('Europe/Madrid', fecha, hora))
    assert.equal(p.fecha, fecha, `fecha en ${fecha}`)
    assert.equal(p.minutos, 9 * 60, `hora en ${fecha}`)
  }
})

/* ---- Próxima apertura --------------------------------------------------- */

prueba('un lunes de madrugada abre ese mismo lunes', () =>
  assert.equal(
    proximaApertura(MADRID, new Date('2026-08-17T04:00:00Z')).toISOString(),
    '2026-08-17T07:00:00.000Z', // 09:00 en Madrid, verano
  ),
)
prueba('un viernes por la tarde salta al lunes siguiente', () =>
  assert.equal(
    proximaApertura(MADRID, new Date('2026-08-21T17:00:00Z')).toISOString(),
    '2026-08-24T07:00:00.000Z',
  ),
)
prueba('un sábado salta al lunes', () =>
  assert.equal(
    proximaApertura(MADRID, new Date('2026-08-22T10:00:00Z')).toISOString(),
    '2026-08-24T07:00:00.000Z',
  ),
)
prueba('una ventana sin días hábiles no cuelga', () => {
  const nunca: SendingWindow = { ...MADRID, days: [] }
  assert.ok(proximaApertura(nunca, new Date('2026-08-17T10:00:00Z')) > new Date('2026-08-17T10:00:00Z'))
})

/* ---- Otra zona horaria -------------------------------------------------- */

prueba('funciona igual en LATAM', () => {
  const mexico: SendingWindow = { tz: 'America/Mexico_City', from: '09:00', to: '18:00', days: [1, 2, 3, 4, 5] }
  // 15:00 UTC = 09:00 en Ciudad de México.
  assert.equal(dentroDeVentana(mexico, new Date('2026-08-17T15:00:00Z')), true)
  assert.equal(dentroDeVentana(mexico, new Date('2026-08-17T14:00:00Z')), false)
})

console.log(`\n${ok} comprobaciones correctas`)
if (fallos.length) {
  console.error(`\n${fallos.length} FALLOS:\n`)
  for (const f of fallos) console.error(`  ✗ ${f}\n`)
  process.exit(1)
}
console.log('Ventana de envío verificada.')
