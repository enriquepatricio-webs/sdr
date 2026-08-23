/** Pruebas del reabastecimiento. `npm run test:reabastecer`. */
import assert from 'node:assert/strict'
import { planificarReabastecimiento, type EstadoCampana } from './replenish'

let ok = 0
const fallos: string[] = []
function prueba(n: string, fn: () => void) {
  try { fn(); ok++ } catch (e) { fallos.push(`${n}\n    ${(e as Error).message.split('\n')[0]}`) }
}

const CAMPANA: EstadoCampana = {
  id: 'c1', name: 'Fundadores', status: 'running', icpId: 'icp1', leadsPendientes: 0,
}
const BASE = {
  activo: true,
  campanas: [CAMPANA],
  busquedasAutomaticasHoy: 0,
  maxBusquedasDia: 4,
  minLeads: 20,
}

prueba('apagado: no hace nada', () => {
  const p = planificarReabastecimiento({ ...BASE, activo: false })
  assert.equal(p.procede, false)
  assert.equal(!p.procede && p.motivo, 'desactivado')
})

prueba('una campaña seca y en marcha pide leads', () => {
  const p = planificarReabastecimiento(BASE)
  assert.equal(p.procede, true)
  assert.equal(p.procede && p.campanas.length, 1)
  assert.equal(p.procede && p.campanas[0].faltan, 20)
})

prueba('una campaña PAUSADA no pide leads aunque esté seca', () => {
  // Si el freno de mano está echado, el sistema no puede rearmarse solo.
  const p = planificarReabastecimiento({
    ...BASE, campanas: [{ ...CAMPANA, status: 'paused' }],
  })
  assert.equal(p.procede, false)
  assert.equal(!p.procede && p.motivo, 'ninguna_campana_en_marcha')
})

prueba('con leads de sobra no gasta dinero', () => {
  const p = planificarReabastecimiento({
    ...BASE, campanas: [{ ...CAMPANA, leadsPendientes: 200 }],
  })
  assert.equal(p.procede, false)
  assert.equal(!p.procede && p.motivo, 'todas_con_leads')
})

prueba('el tope de búsquedas diarias frena el gasto', () => {
  const p = planificarReabastecimiento({ ...BASE, busquedasAutomaticasHoy: 4 })
  assert.equal(p.procede, false)
  assert.equal(!p.procede && p.motivo, 'tope_de_busquedas_diarias')
})

prueba('nunca lanza más búsquedas de las que quedan', () => {
  const campanas = Array.from({ length: 10 }, (_, i) => ({
    ...CAMPANA, id: `c${i}`, leadsPendientes: i,
  }))
  const p = planificarReabastecimiento({ ...BASE, campanas, busquedasAutomaticasHoy: 3 })
  assert.equal(p.procede && p.campanas.length, 1, 'quedaba 1 búsqueda y lanzó más')
})

prueba('atiende primero a la campaña más seca', () => {
  const campanas = [
    { ...CAMPANA, id: 'llena', leadsPendientes: 19 },
    { ...CAMPANA, id: 'seca', leadsPendientes: 0 },
  ]
  const p = planificarReabastecimiento({ ...BASE, campanas, maxBusquedasDia: 1 })
  assert.equal(p.procede && p.campanas[0].id, 'seca')
})

prueba('una campaña sin ICP no puede buscar', () => {
  const p = planificarReabastecimiento({
    ...BASE, campanas: [{ ...CAMPANA, icpId: null }],
  })
  assert.equal(p.procede, false)
  assert.equal(!p.procede && p.motivo, 'sin_icp')
})

prueba('el plan NO contiene ningún dato de cupo de envío', () => {
  // Reabastecer y enviar son decisiones separadas a propósito. Si algún día
  // este plan empieza a hablar de topes de envío, se han mezclado.
  const p = planificarReabastecimiento(BASE)
  const texto = JSON.stringify(p).toLowerCase()
  for (const prohibido of ['dailylimit', 'tope', 'cupo', 'enviados']) {
    assert.ok(!texto.includes(prohibido), `el plan menciona "${prohibido}"`)
  }
})

console.log(`\n${ok} comprobaciones correctas`)
if (fallos.length) {
  console.error(`\n${fallos.length} FALLOS:\n`)
  for (const f of fallos) console.error(`  ✗ ${f}\n`)
  process.exit(1)
}
console.log('Reabastecimiento verificado.')
