/**
 * Validación de los workflows de n8n. `npm run test:n8n`.
 *
 * No se pueden importar en n8n desde aquí, así que se comprueba lo que sí puede
 * verificarse sin él: que el JSON es válido, que las conexiones apuntan a nodos
 * que existen, que cada agente tiene modelo y herramientas, y sobre todo que
 * ningún nodo se salta la API para escribir a un prospecto por su cuenta.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Nodo = {
  id: string
  name: string
  type: string
  typeVersion: number
  position: [number, number]
  parameters?: Record<string, unknown>
}
type Workflow = {
  name: string
  nodes: Nodo[]
  connections: Record<string, Record<string, { node: string; type: string; index: number }[][]>>
  settings?: unknown
}

let ok = 0
const fallos: string[] = []
function prueba(nombre: string, fn: () => void) {
  try { fn(); ok++ } catch (e) { fallos.push(`${nombre}\n    ${(e as Error).message.split('\n')[0]}`) }
}

/**
 * Los SEIS que corren de verdad, no cuatro.
 *
 * W5 y W6 existian solo dentro de n8n: si ese servidor se pierde, hay que
 * reconstruirlos de memoria. Y un repositorio que describe cuatro de los seis
 * workflows que corren es peor que uno que no describe ninguno, porque invita a
 * razonar sobre un sistema que no es el que esta funcionando.
 */
const FICHEROS = [
  'sdr-outbound',
  'sdr-inbound',
  'sdr-followup',
  'sdr-magnets',
  'sdr-replenish',
  'sdr-sweep',
]
const workflows: Record<string, Workflow> = {}

for (const f of FICHEROS) {
  prueba(`${f}.json es JSON válido`, () => {
    workflows[f] = JSON.parse(readFileSync(join('n8n', `${f}.json`), 'utf8'))
  })
}

for (const f of FICHEROS) {
  const w = workflows[f]
  if (!w) continue

  prueba(`${f}: todos los nodos tienen los campos que exige n8n`, () => {
    for (const n of w.nodes) {
      for (const campo of ['id', 'name', 'type', 'typeVersion', 'position'] as const) {
        assert.ok(n[campo] !== undefined, `al nodo "${n.name ?? '?'}" le falta ${campo}`)
      }
      assert.ok(Array.isArray(n.position) && n.position.length === 2, `posición inválida en ${n.name}`)
    }
  })

  prueba(`${f}: no hay nombres de nodo repetidos`, () => {
    const nombres = w.nodes.map((n) => n.name)
    assert.equal(new Set(nombres).size, nombres.length, `repetidos: ${nombres.filter((x, i) => nombres.indexOf(x) !== i)}`)
  })

  prueba(`${f}: todas las conexiones apuntan a nodos que existen`, () => {
    const existentes = new Set(w.nodes.map((n) => n.name))
    for (const [origen, tipos] of Object.entries(w.connections)) {
      assert.ok(existentes.has(origen), `conexión desde "${origen}", que no existe`)
      for (const salidas of Object.values(tipos)) {
        for (const salida of salidas) {
          for (const c of salida) {
            assert.ok(existentes.has(c.node), `"${origen}" conecta con "${c.node}", que no existe`)
          }
        }
      }
    }
  })

  prueba(`${f}: tiene exactamente un disparador`, () => {
    const disparadores = w.nodes.filter(
      (n) => n.type.includes('scheduleTrigger') || n.type.includes('webhook'),
    )
    assert.equal(disparadores.length, 1, `tiene ${disparadores.length}`)
  })

  prueba(`${f}: no hay nodos huérfanos`, () => {
    const alcanzados = new Set<string>()
    for (const [origen, tipos] of Object.entries(w.connections)) {
      alcanzados.add(origen)
      for (const salidas of Object.values(tipos)) {
        for (const salida of salidas) for (const c of salida) alcanzados.add(c.node)
      }
    }
    const huerfanos = w.nodes.filter((n) => !alcanzados.has(n.name))
    assert.equal(huerfanos.length, 0, `sueltos: ${huerfanos.map((n) => n.name).join(', ')}`)
  })

  prueba(`${f}: cada agente tiene un modelo conectado`, () => {
    const agentes = w.nodes.filter((n) => n.type.endsWith('.agent'))
    for (const a of agentes) {
      const tieneModelo = Object.values(w.connections).some((tipos) =>
        (tipos.ai_languageModel ?? []).some((s) => s.some((c) => c.node === a.name)),
      )
      assert.ok(tieneModelo, `"${a.name}" no tiene modelo`)
    }
  })

  /* La comprobación que de verdad importa. */
  prueba(`${f}: ningún nodo escribe al prospecto saltándose la API`, () => {
    const texto = JSON.stringify(w)
    for (const prohibido of ['unipile.com', 'backend.composio.dev', 'api.telegram.org']) {
      assert.ok(
        !texto.includes(prohibido),
        `hay una llamada directa a ${prohibido}. Todo envío tiene que pasar por /api/messages/send, que registra el toque ANTES de enviar y respeta el autopiloto.`,
      )
    }
  })

  /**
   * Todo lo que llega a una persona sale del dashboard, nunca de n8n.
   *
   * W2 lo hace a través de una herramienta del agente y W4 ni siquiera envía
   * desde aquí: delega el ciclo entero en `/api/magnets/run`, que por dentro
   * usa el mismo registrar → enviar → confirmar. Lo que esta comprobación
   * defiende de verdad es que ninguno de los cuatro tenga un nodo que hable con
   * Unipile por su cuenta; de eso se encarga la comprobación de más arriba.
   */
  const DELEGAN = {
    'sdr-inbound': 'herramienta del agente',
    'sdr-magnets': '/api/magnets/run',
    // Estos dos no escriben a nadie: W5 rellena la cola y W6 devuelve al flujo
    // de entrantes lo que llego y nadie atendio. Quien envia sigue siendo W2.
    'sdr-replenish': 'no envia: solo rellena la cola',
    'sdr-sweep': 'no envia: reinyecta en W2',
  }
  prueba(`${f}: los envíos van por la API del dashboard`, () => {
    const texto = JSON.stringify(w)
    const delega = f in DELEGAN
    assert.ok(
      texto.includes('/api/messages/send') || delega,
      'no hay ningún nodo que envíe ni delegue el envío en la API',
    )
    if (f === 'sdr-magnets') {
      assert.ok(texto.includes('/api/magnets/run'), 'W4 no llama al ciclo de los imanes')
    }
  })
}

/* Comprobaciones concretas de cada workflow. */

/**
 * El reabastecimiento NO va delante del envio.
 *
 * Estuvo ahi y se saco a W5 a proposito: tarda minutos y retrasaba cada vuelta
 * de W1. El fichero del repo se quedo con el nodo viejo mucho despues de que
 * produccion dejara de tenerlo, y leerlo llevo a concluir que habia una llamada
 * duplicada que no existia. Esta comprobacion existe para que el repo no vuelva
 * a contar una historia distinta de la que corre.
 */
prueba('W1 pide trabajo sin reabastecer primero', () => {
  const texto = JSON.stringify(workflows['sdr-outbound'])
  assert.ok(texto.includes('mode=primer_toque'), 'W1 no pide primeros toques')
  assert.ok(
    !texto.includes('/api/prospect/replenish'),
    'W1 vuelve a reabastecer antes de enviar: eso retrasa cada vuelta y ya vive en W5',
  )
})

prueba('el reabastecimiento vive en W5, y el barrido en W6', () => {
  assert.ok(
    JSON.stringify(workflows['sdr-replenish']).includes('/api/prospect/replenish'),
    'W5 no reabastece',
  )
  assert.ok(
    JSON.stringify(workflows['sdr-sweep']).includes('/api/messages/sweep'),
    'W6 no barre las respuestas sin contestar',
  )
})

prueba('W1 espera un tiempo aleatorio entre leads', () => {
  const w = workflows['sdr-outbound']
  const espera = w.nodes.find((n) => n.type.includes('wait'))
  assert.ok(espera, 'no hay nodo de espera')
  const amount = String((espera.parameters as { amount?: unknown })?.amount ?? '')
  assert.match(amount, /Math\.random/, 'la espera es fija; un intervalo regular es lo que detecta el antifraude')
})

prueba('W2 descarta nuestros propios mensajes antes de invocar al agente', () => {
  const w = workflows['sdr-inbound']
  const code = w.nodes.find((n) => n.type.includes('code'))
  assert.ok(code, 'no hay nodo de código')
  const js = String((code.parameters as { jsCode?: string })?.jsCode ?? '')
  assert.match(js, /account_info/, 'no compara account_info.user_id')
  assert.match(js, /attendee_provider_id/, 'no compara sender.attendee_provider_id')
})

/* n8n renombró el nodo de herramienta HTTP: antes
 * "@n8n/n8n-nodes-langchain.toolHttpRequest", ahora "n8n-nodes-base.httpRequestTool".
 * Se aceptan las dos formas para no depender del nombre viejo. */
const esHerramientaHttp = (n: Nodo) =>
  n.type.includes('toolHttpRequest') || n.type.includes('httpRequestTool')

prueba('W2 lleva las seis herramientas del spec', () => {
  const w = workflows['sdr-inbound']
  const tools = w.nodes.filter((n) => esHerramientaHttp(n)).map((n) => n.name)
  for (const t of [
    'registrar_cualificacion', 'consultar_disponibilidad', 'agendar_reunion',
    'responder', 'descartar', 'escalar_humano',
  ]) {
    assert.ok(tools.includes(t), `falta la herramienta ${t}`)
  }
})

prueba('W2 conecta todas las herramientas al agente', () => {
  const w = workflows['sdr-inbound']
  const tools = w.nodes.filter((n) => esHerramientaHttp(n))
  for (const t of tools) {
    const conectada = (w.connections[t.name]?.ai_tool ?? []).some((s) =>
      s.some((c) => c.node === 'Agente SDR'),
    )
    assert.ok(conectada, `"${t.name}" no está conectada al agente`)
  }
})

prueba('W2 tiene memoria de conversación por hilo', () => {
  const w = workflows['sdr-inbound']
  const mem = w.nodes.find((n) => n.type.includes('memoryBufferWindow'))
  assert.ok(mem, 'no hay memoria')
  assert.match(String((mem.parameters as { sessionKey?: string })?.sessionKey ?? ''), /chatId/)
})

prueba('W3 le pasa el hilo previo al agente para que no se repita', () => {
  const texto = JSON.stringify(workflows['sdr-followup'])
  assert.ok(texto.includes('/api/leads/resolve'), 'W3 no carga el historial')
  assert.ok(texto.includes('mode=seguimiento'), 'W3 no pide seguimientos')
  assert.match(texto, /no repitas/i, 'no se le dice al agente que no se repita')
})

/**
 * Un lead que viene de un imán YA ha hablado contigo.
 *
 * El prompt afirmaba siempre "el prospecto no ha contestado", y con esa premisa
 * el modelo escribía un primer contacto en frío —"no nos conocemos de nada"— a
 * alguien que acababa de pedir un recurso y de recibirlo. Nada delata más
 * rápido que detrás no hay una persona.
 */
prueba('W3 no se presenta a quien ya ha hablado contigo', () => {
  const texto = JSON.stringify(workflows['sdr-followup'])
  assert.match(texto, /no te presentes otra vez/i, 'puede volver a presentarse')
  assert.ok(
    texto.includes('headline'),
    'W3 no le dice al agente de dónde sale el lead',
  )
  assert.ok(
    !texto.includes('El prospecto no ha contestado al mensaje anterior'),
    'W3 sigue dando por hecho que el prospecto no ha contestado',
  )
})

prueba('W1 lee el perfil del prospecto ANTES de redactarle', () => {
  const w = workflows['sdr-outbound']
  const enriquecer = w.nodes.find((n) =>
    String((n.parameters as { url?: string })?.url ?? '').includes('/enrich'),
  )
  assert.ok(enriquecer, 'W1 no enriquece: escribiría un mensaje genérico a todo el mundo')

  // Y tiene que ir por delante del que redacta, no en paralelo ni después.
  const siguientes = w.connections[enriquecer.name]?.main?.[0]?.map((c) => c.node) ?? []
  assert.ok(
    siguientes.includes('Playbook activo'),
    'el enriquecimiento no desemboca en el playbook: el agente no vería lo scrapeado',
  )
})

prueba('W1 y W3 piden el playbook de LA EMPRESA de la campaña', () => {
  for (const f of ['sdr-outbound', 'sdr-followup']) {
    const nodo = workflows[f].nodes.find((n) => n.name === 'Playbook activo')!
    const url = String((nodo.parameters as { url?: string }).url ?? '')
    assert.ok(
      url.includes('campaign_id='),
      `${f} pide el playbook sin campaign_id: con varias empresas escribiría de parte de la equivocada`,
    )
    assert.ok(url.includes('lead_id='), `${f} no pasa lead_id: el mensaje saldría sin personalizar`)
  }
})

prueba('todos apuntan al dominio de producción', () => {
  for (const f of FICHEROS) {
    assert.ok(
      JSON.stringify(workflows[f]).includes('sdr.thecotocompany.com'),
      `${f} no apunta al dominio de producción`,
    )
  }
})

console.log(`\n${ok} comprobaciones correctas`)
if (fallos.length) {
  console.error(`\n${fallos.length} FALLOS:\n`)
  for (const f of fallos) console.error(`  ✗ ${f}\n`)
  process.exit(1)
}
console.log('Workflows de n8n verificados.')
