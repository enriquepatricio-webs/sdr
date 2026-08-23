/**
 * Pruebas del cupo de envío. `npm run test:cupo`.
 *
 * Esta es la regla que impide que Instagram o LinkedIn bloqueen una cuenta.
 * Con el reabastecimiento automático encendido la cola de leads nunca se vacía,
 * así que lo único que separa al sistema de mandar mil mensajes en un día es
 * este cálculo. Se prueba a conciencia.
 */
import assert from 'node:assert/strict'
import { calcularCupo, type EntradaCupo } from './quota'

let ok = 0
const fallos: string[] = []
function prueba(nombre: string, fn: () => void) {
  try { fn(); ok++ } catch (e) { fallos.push(`${nombre}\n    ${(e as Error).message.split('\n')[0]}`) }
}

const BASE: EntradaCupo = {
  topeDiarioCuenta: 25,
  topeDiarioCampana: 25,
  topeHorarioCuenta: null,
  enviadosHoyCuenta: 0,
  enviadosHoyCampana: 0,
  enviadosEstaHoraCuenta: 0,
  lote: 25,
}

prueba('cuenta nueva: cupo completo', () => {
  const c = calcularCupo(BASE)
  assert.equal(c.hay, true)
  assert.equal(c.hay && c.cuantos, 25)
})

prueba('gasta lo que ya salió hoy', () => {
  const c = calcularCupo({ ...BASE, enviadosHoyCuenta: 18, enviadosHoyCampana: 18 })
  assert.equal(c.hay && c.cuantos, 7)
})

prueba('al llegar al tope no hay cupo', () => {
  const c = calcularCupo({ ...BASE, enviadosHoyCuenta: 25, enviadosHoyCampana: 25 })
  assert.equal(c.hay, false)
  assert.equal(!c.hay && c.motivo, 'tope_diario_cuenta')
})

prueba('pasarse del tope tampoco da cupo negativo', () => {
  const c = calcularCupo({ ...BASE, enviadosHoyCuenta: 40, enviadosHoyCampana: 40 })
  assert.equal(c.hay, false)
})

prueba('el tope de la CUENTA manda sobre varias campañas', () => {
  // Dos campañas de 25 colgando de una cuenta de 30: cuando la cuenta lleva 28,
  // a la segunda campaña le quedan 2, no 25.
  const c = calcularCupo({
    ...BASE,
    topeDiarioCuenta: 30,
    topeDiarioCampana: 25,
    enviadosHoyCuenta: 28,
    enviadosHoyCampana: 3,
  })
  assert.equal(c.hay && c.cuantos, 2)
  assert.equal(c.hay && c.limitadoPor, 'cuenta')
})

prueba('el tope de la campaña también frena aunque la cuenta tenga margen', () => {
  const c = calcularCupo({
    ...BASE,
    topeDiarioCuenta: 80,
    topeDiarioCampana: 10,
    enviadosHoyCuenta: 12,
    enviadosHoyCampana: 10,
  })
  assert.equal(c.hay, false)
  assert.equal(!c.hay && c.motivo, 'tope_diario_campana')
})

prueba('el tope horario de Instagram frena aunque quede cupo diario', () => {
  // 8 por hora: 100 al día en diez minutos es justo lo que detecta el antifraude.
  const c = calcularCupo({
    ...BASE,
    topeDiarioCuenta: 40,
    topeDiarioCampana: 40,
    topeHorarioCuenta: 8,
    enviadosHoyCuenta: 10,
    enviadosEstaHoraCuenta: 8,
  })
  assert.equal(c.hay, false)
  assert.equal(!c.hay && c.motivo, 'tope_horario')
})

prueba('con margen horario, el cupo se recorta a lo que queda de hora', () => {
  const c = calcularCupo({
    ...BASE,
    topeDiarioCuenta: 40, topeDiarioCampana: 40,
    topeHorarioCuenta: 8, enviadosEstaHoraCuenta: 5,
  })
  assert.equal(c.hay && c.cuantos, 3)
  assert.equal(c.hay && c.limitadoPor, 'hora')
})

prueba('sin tope horario no se aplica ninguno', () => {
  const c = calcularCupo({ ...BASE, topeHorarioCuenta: null, enviadosEstaHoraCuenta: 999 })
  assert.equal(c.hay && c.cuantos, 25)
})

prueba('el lote pedido nunca aumenta el cupo, solo lo recorta', () => {
  const pequeno = calcularCupo({ ...BASE, lote: 5 })
  assert.equal(pequeno.hay && pequeno.cuantos, 5)
  const grande = calcularCupo({ ...BASE, lote: 1000 })
  assert.equal(grande.hay && grande.cuantos, 25, 'un lote enorme no puede saltarse el tope')
})

/* La comprobación que motiva todo esto. */
prueba('con reabastecimiento automático, tener leads infinitos NO da cupo extra', () => {
  // El número de leads disponibles no aparece en EntradaCupo, así que no puede
  // influir. Esta prueba lo deja escrito: si alguien añade un campo "leads
  // disponibles" a este cálculo, el diseño se ha roto y hay que discutirlo.
  const campos = Object.keys(BASE)
  for (const sospechoso of ['leads', 'disponibles', 'pendientes', 'cola']) {
    assert.ok(
      !campos.some((c) => c.toLowerCase().includes(sospechoso)),
      `el cupo no puede depender de "${sospechoso}"`,
    )
  }
  // Y con los topes agotados, da igual lo que haya en la cola.
  const c = calcularCupo({ ...BASE, enviadosHoyCuenta: 25, enviadosHoyCampana: 25, lote: 100_000 })
  assert.equal(c.hay, false)
})

prueba('el tope máximo del sistema sigue siendo 80', () => {
  const c = calcularCupo({ ...BASE, topeDiarioCuenta: 80, topeDiarioCampana: 80, lote: 500 })
  assert.equal(c.hay && c.cuantos, 80)
})

console.log(`\n${ok} comprobaciones correctas`)
if (fallos.length) {
  console.error(`\n${fallos.length} FALLOS:\n`)
  for (const f of fallos) console.error(`  ✗ ${f}\n`)
  process.exit(1)
}
console.log('Cupo de envío verificado.')
