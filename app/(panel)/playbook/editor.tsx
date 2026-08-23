'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { BookingRules, Objection, QualificationCriterion } from '@/lib/db/schema'
import { estimateTokens } from '@/lib/openrouter'
import { PanelEnsayo, type PeticionEnsayo, type ResultadoEnsayo } from './ensayo'

type PlaybookInicial = {
  id: string
  name: string
  version: number
  systemPrompt: string
  offer: string
  qualificationCriteria: QualificationCriterion[]
  objections: Objection[]
  bookingRules: BookingRules
}

type VersionHistorial = {
  id: string
  name: string
  version: number
  isActive: boolean
  createdAt: string
}

const DIAS = [
  { n: 1, l: 'L' },
  { n: 2, l: 'M' },
  { n: 3, l: 'X' },
  { n: 4, l: 'J' },
  { n: 5, l: 'V' },
  { n: 6, l: 'S' },
  { n: 7, l: 'D' },
]

function Campo({
  etiqueta,
  ayuda,
  children,
}: {
  etiqueta: string
  ayuda?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="etiqueta">{etiqueta}</p>
      {ayuda && <p className="mt-0.5 text-xs text-tenue">{ayuda}</p>}
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

function Bloque({
  numero,
  titulo,
  descripcion,
  extra,
  children,
}: {
  numero: string
  titulo: string
  descripcion: string
  extra?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="border border-linea bg-lienzo">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-linea px-4 py-3">
        <span className="font-mono text-xs text-tenue">{numero}</span>
        <h2 className="text-base font-semibold">{titulo}</h2>
        <p className="text-xs text-tenue">{descripcion}</p>
        {extra && <div className="ml-auto">{extra}</div>}
      </header>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  )
}

const entradaBase =
  'w-full border border-linea-fuerte bg-papel px-3 py-2 text-sm outline-none focus:border-ensayo'

export function EditorPlaybook({
  inicial,
  historial,
  icps,
}: {
  inicial: PlaybookInicial
  historial: VersionHistorial[]
  icps: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [guardando, guardar] = useTransition()

  const [systemPrompt, setSystemPrompt] = useState(inicial.systemPrompt)
  const [offer, setOffer] = useState(inicial.offer)
  const [criterios, setCriterios] = useState<QualificationCriterion[]>(inicial.qualificationCriteria)
  const [objeciones, setObjeciones] = useState<Objection[]>(inicial.objections)
  const [reglas, setReglas] = useState<BookingRules>(inicial.bookingRules)
  const [icpId, setIcpId] = useState(icps[0]?.id)
  const [canal, setCanal] = useState<'linkedin' | 'email' | 'instagram'>('linkedin')

  const [ensayando, setEnsayando] = useState(false)
  const [resultado, setResultado] = useState<ResultadoEnsayo | null>(null)
  const [errorEnsayo, setErrorEnsayo] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)

  const tokens = useMemo(() => estimateTokens(systemPrompt), [systemPrompt])
  const sumaPesos = useMemo(() => criterios.reduce((s, c) => s + (c.weight || 0), 0), [criterios])
  const proximaVersion = Math.max(...historial.map((h) => h.version), inicial.version) + 1

  const cuerpoActual = () => ({
    systemPrompt,
    offer,
    qualificationCriteria: criterios,
    objections: objeciones,
    bookingRules: reglas,
  })

  async function probar(peticion: PeticionEnsayo) {
    setEnsayando(true)
    setErrorEnsayo(null)
    try {
      const res = await fetch('/api/playbook/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cuerpoActual(), ...peticion, canal, icpId }),
      })
      const json = await res.json()
      if (!res.ok) {
        setErrorEnsayo(json.error ?? 'El ensayo falló.')
        setResultado(null)
      } else {
        setResultado(json)
      }
    } catch (err) {
      setErrorEnsayo(err instanceof Error ? err.message : 'No se pudo contactar con el servidor.')
    } finally {
      setEnsayando(false)
    }
  }

  function guardarVersion() {
    guardar(async () => {
      setAviso(null)
      const res = await fetch('/api/playbook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: inicial.name, ...cuerpoActual(), activar: true }),
      })
      const json = await res.json()
      if (!res.ok) {
        setAviso(json.error ?? 'No se pudo guardar.')
        return
      }
      setAviso(`Guardado como v${json.version} y activado.`)
      router.refresh()
    })
  }

  function activar(id: string, version: number) {
    guardar(async () => {
      const res = await fetch(`/api/playbook/${id}/activate`, { method: 'POST' })
      setAviso(res.ok ? `Activada la v${version}.` : 'No se pudo activar esa versión.')
      router.refresh()
    })
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="etiqueta">Entrenamiento de ventas</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">{inicial.name}</h1>
            <p className="mt-1 text-sm text-apagado">
              Editando sobre la <span className="font-mono">v{inicial.version}</span>. Al guardar se
              crea la <span className="font-mono">v{proximaVersion}</span>; la anterior se queda
              intacta.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {aviso && <p className="text-sm text-ok">{aviso}</p>}
            <button
              type="button"
              onClick={guardarVersion}
              disabled={guardando}
              className="bg-tinta px-4 py-2.5 text-sm font-semibold text-lienzo transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {guardando ? 'Guardando…' : `Guardar como v${proximaVersion}`}
            </button>
          </div>
        </header>

        <Bloque
          numero="01"
          titulo="Rol y reglas duras"
          descripcion="Quién es, cómo escribe, qué no puede hacer nunca."
          extra={
            <span className="font-mono text-xs text-tenue">
              ≈ {tokens.toLocaleString('es-ES')} tokens
            </span>
          }
        >
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={22}
            spellCheck={false}
            aria-label="Prompt de sistema"
            className={`${entradaBase} resize-y font-mono text-[13px] leading-relaxed`}
          />
          <p className="text-xs text-tenue">
            <code className="font-mono">{'{{empresa}}'}</code> y{' '}
            <code className="font-mono">{'{{canal}}'}</code> se sustituyen al montar el prompt.
          </p>
        </Bloque>

        <Bloque numero="02" titulo="Oferta" descripcion="Qué vendes y a qué precio.">
          <textarea
            value={offer}
            onChange={(e) => setOffer(e.target.value)}
            rows={7}
            aria-label="Oferta"
            className={`${entradaBase} resize-y`}
          />
        </Bloque>

        <Bloque
          numero="03"
          titulo="Qué tiene que averiguar"
          descripcion="Máximo 2 preguntas por conversación. El resto se infiere."
          extra={
            <span
              className={`font-mono text-xs ${sumaPesos === 100 ? 'text-ok' : 'text-aviso'}`}
              role="status"
            >
              {sumaPesos === 100 ? 'los pesos suman 100' : `suman ${sumaPesos}, deberían sumar 100`}
            </span>
          }
        >
          {criterios.map((c, i) => (
            <div key={i} className="grid gap-2 border-l-2 border-linea pl-3 sm:grid-cols-[1fr_5rem]">
              <input
                value={c.question}
                onChange={(e) =>
                  setCriterios(criterios.map((x, j) => (i === j ? { ...x, question: e.target.value } : x)))
                }
                aria-label={`Pregunta ${i + 1}`}
                className={entradaBase}
              />
              <input
                type="number"
                min={0}
                max={100}
                value={c.weight}
                onChange={(e) =>
                  setCriterios(
                    criterios.map((x, j) => (i === j ? { ...x, weight: Number(e.target.value) } : x)),
                  )
                }
                aria-label={`Peso del criterio ${i + 1}`}
                className={`${entradaBase} font-mono`}
              />
              <textarea
                value={c.inferable_from ?? ''}
                onChange={(e) =>
                  setCriterios(
                    criterios.map((x, j) => (i === j ? { ...x, inferable_from: e.target.value } : x)),
                  )
                }
                rows={2}
                placeholder="Cómo inferirlo sin gastar una pregunta"
                aria-label={`Cómo inferir el criterio ${i + 1}`}
                className={`${entradaBase} resize-y text-xs sm:col-span-2`}
              />
              <button
                type="button"
                onClick={() => setCriterios(criterios.filter((_, j) => j !== i))}
                className="etiqueta justify-self-start hover:text-vivo sm:col-span-2"
              >
                Quitar criterio
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setCriterios([
                ...criterios,
                { id: `criterio_${criterios.length + 1}`, question: '', weight: 0 },
              ])
            }
            className="border border-linea-fuerte px-3 py-1.5 text-sm text-apagado hover:border-tinta hover:text-tinta"
          >
            Añadir criterio
          </button>
        </Bloque>

        <Bloque
          numero="04"
          titulo="Objeciones"
          descripcion="Lo que te dicen y lo que el agente contesta."
        >
          {objeciones.map((o, i) => (
            <div key={i} className="space-y-2 border-l-2 border-linea pl-3">
              <input
                value={o.objection}
                onChange={(e) =>
                  setObjeciones(
                    objeciones.map((x, j) => (i === j ? { ...x, objection: e.target.value } : x)),
                  )
                }
                aria-label={`Objeción ${i + 1}`}
                className={`${entradaBase} font-semibold`}
              />
              <textarea
                value={o.response}
                onChange={(e) =>
                  setObjeciones(
                    objeciones.map((x, j) => (i === j ? { ...x, response: e.target.value } : x)),
                  )
                }
                rows={3}
                aria-label={`Respuesta a la objeción ${i + 1}`}
                className={`${entradaBase} resize-y`}
              />
              <button
                type="button"
                onClick={() => setObjeciones(objeciones.filter((_, j) => j !== i))}
                className="etiqueta hover:text-vivo"
              >
                Quitar objeción
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setObjeciones([...objeciones, { objection: '', response: '' }])}
            className="border border-linea-fuerte px-3 py-1.5 text-sm text-apagado hover:border-tinta hover:text-tinta"
          >
            Añadir objeción
          </button>
        </Bloque>

        <Bloque numero="05" titulo="Agendado" descripcion="Los límites dentro de los que puede cerrar.">
          <div className="grid gap-4 sm:grid-cols-3">
            <Campo etiqueta="Duración (min)">
              <input
                type="number"
                min={5}
                value={reglas.duration_min}
                onChange={(e) => setReglas({ ...reglas, duration_min: Number(e.target.value) })}
                className={`${entradaBase} font-mono`}
              />
            </Campo>
            <Campo etiqueta="Antelación mínima (h)">
              <input
                type="number"
                min={0}
                value={reglas.min_notice_hours}
                onChange={(e) => setReglas({ ...reglas, min_notice_hours: Number(e.target.value) })}
                className={`${entradaBase} font-mono`}
              />
            </Campo>
            <Campo etiqueta="Colchón (min)">
              <input
                type="number"
                min={0}
                value={reglas.buffer_min}
                onChange={(e) => setReglas({ ...reglas, buffer_min: Number(e.target.value) })}
                className={`${entradaBase} font-mono`}
              />
            </Campo>
            <Campo etiqueta="Desde">
              <input
                type="time"
                value={reglas.working_hours.from}
                onChange={(e) =>
                  setReglas({
                    ...reglas,
                    working_hours: { ...reglas.working_hours, from: e.target.value },
                  })
                }
                className={`${entradaBase} font-mono`}
              />
            </Campo>
            <Campo etiqueta="Hasta">
              <input
                type="time"
                value={reglas.working_hours.to}
                onChange={(e) =>
                  setReglas({
                    ...reglas,
                    working_hours: { ...reglas.working_hours, to: e.target.value },
                  })
                }
                className={`${entradaBase} font-mono`}
              />
            </Campo>
            <Campo etiqueta="Huecos por mensaje">
              <input
                type="number"
                min={1}
                max={5}
                value={reglas.max_slots_offered}
                onChange={(e) => setReglas({ ...reglas, max_slots_offered: Number(e.target.value) })}
                className={`${entradaBase} font-mono`}
              />
            </Campo>
          </div>

          <Campo etiqueta="Días">
            <div className="flex gap-1">
              {DIAS.map(({ n, l }) => {
                const activo = reglas.working_hours.days.includes(n)
                return (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={activo}
                    onClick={() =>
                      setReglas({
                        ...reglas,
                        working_hours: {
                          ...reglas.working_hours,
                          days: activo
                            ? reglas.working_hours.days.filter((d) => d !== n)
                            : [...reglas.working_hours.days, n].sort(),
                        },
                      })
                    }
                    className={`h-9 w-9 border font-mono text-sm ${
                      activo
                        ? 'border-tinta bg-tinta text-lienzo'
                        : 'border-linea-fuerte text-tenue hover:border-tinta'
                    }`}
                  >
                    {l}
                  </button>
                )
              })}
            </div>
          </Campo>

          <Campo
            etiqueta="Score mínimo para agendar"
            ayuda="Umbral duro. Por debajo de esto el agente no puede reservar hueco."
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={100}
                value={reglas.min_score_to_book}
                onChange={(e) => setReglas({ ...reglas, min_score_to_book: Number(e.target.value) })}
                className="w-56 accent-[var(--color-vivo)]"
              />
              <span className="font-mono text-lg">{reglas.min_score_to_book}</span>
            </div>
          </Campo>
        </Bloque>

        <section className="border border-linea bg-lienzo">
          <header className="border-b border-linea px-4 py-3">
            <h2 className="text-base font-semibold">Historial</h2>
          </header>
          <ul className="divide-y divide-linea">
            {historial.map((v) => (
              <li key={v.id} className="flex items-center gap-4 px-4 py-2.5">
                <span className="font-mono text-sm">v{v.version}</span>
                <span className="text-xs text-tenue">
                  {new Date(v.createdAt).toLocaleString('es-ES', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
                {v.isActive ? (
                  <span className="ml-auto font-mono text-[11px] font-bold tracking-widest text-ok uppercase">
                    Activa
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => activar(v.id, v.version)}
                    disabled={guardando}
                    className="etiqueta ml-auto hover:text-tinta disabled:opacity-40"
                  >
                    Activar
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="lg:sticky lg:top-6 lg:self-start">
        <div className="mb-3 flex gap-2">
          {(['linkedin', 'instagram', 'email'] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={canal === c}
              onClick={() => setCanal(c)}
              className={`flex-1 border px-2 py-1.5 text-xs font-medium capitalize ${
                canal === c
                  ? 'border-tinta bg-tinta text-lienzo'
                  : 'border-linea-fuerte text-apagado hover:border-tinta'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        {icps.length > 1 && (
          <select
            value={icpId}
            onChange={(e) => setIcpId(e.target.value)}
            aria-label="ICP con el que ensayar"
            className={`${entradaBase} mb-3`}
          >
            {icps.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        )}
        <PanelEnsayo
          onProbar={probar}
          cargando={ensayando}
          resultado={resultado}
          error={errorEnsayo}
        />
      </div>
    </div>
  )
}
