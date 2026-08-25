'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

type Icp = { id: string; name: string }
type Campana = { id: string; name: string; channel: 'linkedin' | 'email' | 'instagram' }
type Busqueda = {
  id: string
  name: string
  source: string
  status: string
  stats: { encontrados: number; encajan: number; coste_apify_usd?: number; coste_llm_usd?: number } | null
  createdAt: string
}

type Prospecto = {
  id: string
  fullName: string
  headline: string | null
  company: string | null
  location: string | null
  linkedinUrl: string | null
  instagramUsername: string | null
  icpScore: number | null
  icpVerdict: 'encaja' | 'dudoso' | 'no_encaja' | null
  icpReasoning: string | null
  decision: 'pendiente' | 'importado' | 'descartado'
}

type EstadoBusqueda = {
  estado: string
  error?: string | null
  razonamiento?: string | null
  filtros?: Record<string, unknown>
  stats?: Busqueda['stats']
  prospectos: Prospecto[]
}

const entrada =
  'w-full border border-linea-fuerte bg-papel px-3 py-2 text-sm outline-none focus:border-ensayo'

const COLOR_VEREDICTO: Record<string, string> = {
  encaja: 'text-ok',
  dudoso: 'text-aviso',
  no_encaja: 'text-tenue',
}

function dinero(usd: number | undefined | null): string {
  if (!usd) return '—'
  return usd < 0.01 ? `${(usd * 100).toFixed(2)} ¢` : `${usd.toFixed(3)} $`
}

export function Prospeccion({
  icps,
  campanas,
  busquedas,
}: {
  icps: Icp[]
  campanas: Campana[]
  busquedas: Busqueda[]
}) {
  const router = useRouter()

  const [source, setSource] = useState<'linkedin' | 'email'>('linkedin')
  const [icpId, setIcpId] = useState(icps[0]?.id ?? '')
  const [nombre, setNombre] = useState('')
  const [brief, setBrief] = useState('')
  const [maxItems, setMaxItems] = useState(50)
  const [arrancando, setArrancando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [busquedaId, setBusquedaId] = useState<string | null>(null)
  const [detalle, setDetalle] = useState<EstadoBusqueda | null>(null)
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set())
  const [campanaDestino, setCampanaDestino] = useState(campanas[0]?.id ?? '')
  const [resultadoImportar, setResultadoImportar] = useState<string | null>(null)

  const sondeo = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Sondea cada 5 s mientras Apify siga trabajando. Un run tarda minutos:
   * sondear más rápido no lo acelera y gasta invocaciones.
   *
   * Es un bucle y no una llamada que se rellama a sí misma con `setTimeout`
   * porque aquella se referenciaba antes de estar declarada. Al desmontar, el
   * `clearTimeout` deja la promesa sin resolver y el bucle sencillamente no
   * continúa: no queda ningún `setDetalle` sobre un componente que ya no existe.
   */
  const consultar = useCallback(async (id: string) => {
    for (;;) {
      const res = await fetch(`/api/prospect/search/${id}`)
      const json: EstadoBusqueda = await res.json()
      setDetalle(json)
      if (json.estado !== 'ejecutando' && json.estado !== 'puntuando') {
        router.refresh()
        return
      }
      await new Promise((sigue) => {
        sondeo.current = setTimeout(sigue, 5000)
      })
    }
  }, [router])

  useEffect(() => () => { if (sondeo.current) clearTimeout(sondeo.current) }, [])

  async function buscar() {
    setArrancando(true)
    setError(null)
    setDetalle(null)
    setSeleccion(new Set())
    try {
      const res = await fetch('/api/prospect/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          icpId,
          source,
          name: nombre || `${source} · ${new Date().toLocaleDateString('es-ES')}`,
          brief: brief || undefined,
          maxItems,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'No se pudo arrancar la búsqueda.')
        return
      }
      setBusquedaId(json.id)
      consultar(json.id)
    } finally {
      setArrancando(false)
    }
  }

  async function decidir(decision: 'importado' | 'descartado') {
    if (!seleccion.size) return
    const res = await fetch('/api/prospect/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: [...seleccion],
        decision,
        campaignId: decision === 'importado' ? campanaDestino : undefined,
      }),
    })
    const json = await res.json()
    if (!res.ok) {
      setResultadoImportar(json.error ?? 'No se pudo aplicar.')
      return
    }
    setResultadoImportar(
      decision === 'importado'
        ? `${json.importados} importados${json.saltados?.length ? `, ${json.saltados.length} saltados` : ''}.`
        : `${json.descartados} descartados.`,
    )
    setSeleccion(new Set())
    if (busquedaId) consultar(busquedaId)
  }

  const pendientes = (detalle?.prospectos ?? []).filter((p) => p.decision === 'pendiente')

  return (
    <div className="space-y-8">
      <header>
        <p className="etiqueta">Prospectar</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Buscar quién encaja</h1>
        <p className="mt-1 max-w-2xl text-sm text-apagado">
          El ICP se traduce a filtros de búsqueda, Apify los ejecuta y cada perfil se puntúa contra
          el mismo ICP. Nadie entra en una campaña sin que tú lo digas.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* Formulario */}
        <section className="h-fit border border-linea bg-lienzo p-4">
          <h2 className="etiqueta">Nueva búsqueda</h2>

          <div className="mt-3 flex gap-2">
            {(['linkedin', 'email'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={source === s}
                onClick={() => setSource(s)}
                className={`flex-1 border px-2 py-1.5 text-xs font-medium capitalize ${
                  source === s
                    ? 'border-tinta bg-tinta text-lienzo'
                    : 'border-linea-fuerte text-apagado hover:border-tinta'
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          <label htmlFor="icp" className="etiqueta mt-4 block">Perfil de cliente ideal</label>
          <select id="icp" value={icpId} onChange={(e) => setIcpId(e.target.value)} className={`${entrada} mt-1.5`}>
            {icps.map((i) => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </select>

          <label htmlFor="nombre" className="etiqueta mt-4 block">Nombre de la búsqueda</label>
          <input
            id="nombre"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Fundadores de agencia en España"
            className={`${entrada} mt-1.5`}
          />

          <label htmlFor="brief" className="etiqueta mt-4 block">Matiz (opcional)</label>
          <textarea
            id="brief"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            placeholder="Solo Madrid y Barcelona. Evita agencias de más de 50 personas."
            className={`${entrada} mt-1.5 resize-y`}
          />

          <label htmlFor="max" className="etiqueta mt-4 block">
            Tope de perfiles
          </label>
          <p className="mt-0.5 text-xs text-tenue">Es tu tope de gasto. El modelo no puede subirlo.</p>
          <input
            id="max"
            type="number"
            min={1}
            max={500}
            value={maxItems}
            onChange={(e) => setMaxItems(Number(e.target.value))}
            className={`${entrada} mt-1.5 font-mono`}
          />

          <button
            type="button"
            onClick={buscar}
            disabled={arrancando || !icpId}
            className="mt-5 w-full bg-tinta py-2.5 text-sm font-semibold text-lienzo transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {arrancando ? 'Arrancando…' : 'Buscar'}
          </button>

          {error && (
            <p className="mt-3 border-l-2 border-vivo bg-vivo-suave px-3 py-2 text-sm text-vivo">{error}</p>
          )}

          {busquedas.length > 0 && (
            <>
              <h3 className="etiqueta mt-8">Búsquedas anteriores</h3>
              <ul className="mt-2 divide-y divide-linea border-t border-linea">
                {busquedas.map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => { setBusquedaId(b.id); setSeleccion(new Set()); consultar(b.id) }}
                      className="w-full py-2 text-left hover:opacity-70"
                    >
                      <span className="block truncate text-sm">{b.name}</span>
                      <span className="font-mono text-[11px] text-tenue">
                        {b.status} · {b.stats?.encajan ?? 0} encajan de {b.stats?.encontrados ?? 0}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {/* Resultados */}
        <section className="space-y-4">
          {!detalle && (
            <div className="border border-dashed border-linea-fuerte p-10 text-center">
              <p className="text-sm text-tenue">
                Lanza una búsqueda o abre una anterior para ver los candidatos.
              </p>
            </div>
          )}

          {detalle && (
            <>
              {/* Transparencia: qué filtros eligió el modelo y por qué. Cuando una
                  búsqueda sale mal, esto es lo primero que hay que poder leer. */}
              {detalle.razonamiento && (
                <div className="border border-linea bg-lienzo p-4">
                  <h2 className="etiqueta">Cómo tradujo el ICP</h2>
                  <p className="mt-1.5 text-sm">{detalle.razonamiento}</p>
                  {detalle.filtros && (
                    <pre className="mt-3 overflow-x-auto border border-linea bg-papel p-3 font-mono text-[11px] text-apagado">
                      {JSON.stringify(detalle.filtros, null, 2)}
                    </pre>
                  )}
                </div>
              )}

              {(detalle.estado === 'ejecutando' || detalle.estado === 'puntuando') && (
                <p className="border-l-2 border-ensayo bg-ensayo-suave px-4 py-3 text-sm">
                  {detalle.estado === 'ejecutando'
                    ? 'Apify está buscando. Tarda entre uno y diez minutos; puedes irte de esta pantalla.'
                    : 'Puntuando los perfiles contra el ICP…'}
                </p>
              )}

              {detalle.error && (
                <p className="border-l-2 border-vivo bg-vivo-suave px-4 py-3 text-sm text-vivo">
                  {detalle.error}
                </p>
              )}

              {detalle.stats && detalle.estado === 'completada' && (
                <dl className="grid grid-cols-2 gap-4 border border-linea bg-lienzo p-4 sm:grid-cols-4">
                  {[
                    ['Encontrados', String(detalle.stats.encontrados)],
                    ['Encajan', String(detalle.stats.encajan)],
                    ['Coste Apify', dinero(detalle.stats.coste_apify_usd)],
                    ['Coste modelo', dinero(detalle.stats.coste_llm_usd)],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt className="etiqueta">{k}</dt>
                      <dd className="font-mono text-lg">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {pendientes.length > 0 && (
                <div className="flex flex-wrap items-center gap-3 border border-linea bg-lienzo p-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={seleccion.size === pendientes.length && pendientes.length > 0}
                      onChange={(e) =>
                        setSeleccion(e.target.checked ? new Set(pendientes.map((p) => p.id)) : new Set())
                      }
                    />
                    {seleccion.size ? `${seleccion.size} seleccionados` : 'Seleccionar todo'}
                  </label>

                  <select
                    value={campanaDestino}
                    onChange={(e) => setCampanaDestino(e.target.value)}
                    aria-label="Campaña de destino"
                    className="ml-auto border border-linea-fuerte bg-papel px-2 py-1.5 text-sm"
                  >
                    {campanas.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.channel})
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    disabled={!seleccion.size || !campanaDestino}
                    onClick={() => decidir('importado')}
                    className="bg-tinta px-3 py-1.5 text-sm font-semibold text-lienzo disabled:opacity-40"
                  >
                    Importar a la campaña
                  </button>
                  <button
                    type="button"
                    disabled={!seleccion.size}
                    onClick={() => decidir('descartado')}
                    className="border border-linea-fuerte px-3 py-1.5 text-sm text-apagado hover:border-tinta hover:text-tinta disabled:opacity-40"
                  >
                    Descartar
                  </button>
                  {resultadoImportar && <p className="w-full text-sm text-ok">{resultadoImportar}</p>}
                </div>
              )}

              <ul className="divide-y divide-linea border border-linea bg-lienzo">
                {detalle.prospectos.map((p) => (
                  <li key={p.id} className="flex gap-3 p-3">
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={p.decision !== 'pendiente'}
                      checked={seleccion.has(p.id)}
                      aria-label={`Seleccionar ${p.fullName}`}
                      onChange={(e) => {
                        const s = new Set(seleccion)
                        if (e.target.checked) s.add(p.id)
                        else s.delete(p.id)
                        setSeleccion(s)
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{p.fullName}</span>
                        {p.company && <span className="text-sm text-apagado">· {p.company}</span>}
                        {p.location && <span className="text-xs text-tenue">· {p.location}</span>}
                      </div>
                      {p.headline && <p className="truncate text-sm text-apagado">{p.headline}</p>}
                      {p.icpReasoning && (
                        <p className="mt-1 text-xs text-tenue">{p.icpReasoning}</p>
                      )}
                      {p.decision !== 'pendiente' && (
                        <span className="etiqueta mt-1 inline-block">{p.decision}</span>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-lg leading-none">{p.icpScore ?? '—'}</p>
                      <p className={`font-mono text-[11px] uppercase ${COLOR_VEREDICTO[p.icpVerdict ?? ''] ?? 'text-tenue'}`}>
                        {p.icpVerdict?.replace('_', ' ') ?? ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
