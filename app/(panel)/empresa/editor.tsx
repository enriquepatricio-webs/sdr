'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

type Empresa = {
  id: string
  name: string
  website: string | null
  context: string | null
  scrapedContext: string | null
  scrapedAt: string | null
  offer: string | null
  createdAt: string
}

const entrada = 'w-full border border-linea-fuerte bg-papel px-3 py-2 text-sm outline-none focus:border-ensayo'

export function EditorEmpresas({ inicial }: { inicial: Empresa[] }) {
  const router = useRouter()
  const [lista, setLista] = useState(inicial)
  const [activa, setActiva] = useState(inicial[0]?.id ?? null)
  const [guardando, guardar] = useTransition()
  const [leyendo, setLeyendo] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const e = lista.find((x) => x.id === activa)

  function actualizar(cambios: Partial<Empresa>) {
    setLista(lista.map((x) => (x.id === activa ? { ...x, ...cambios } : x)))
  }

  function guardarEmpresa() {
    if (!e) return
    guardar(async () => {
      setAviso(null); setError(null)
      const res = await fetch(`/api/sellers/${e.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: e.name, website: e.website, context: e.context, offer: e.offer }),
      })
      if (res.ok) { setAviso('Guardado.'); router.refresh() }
      else setError((await res.json()).error ?? 'No se pudo guardar.')
    })
  }

  async function leerWeb() {
    if (!e) return
    setLeyendo(true); setAviso(null); setError(null)
    try {
      const res = await fetch(`/api/sellers/${e.id}/scrape`, { method: 'POST' })
      const json = await res.json()
      if (res.ok) {
        setAviso(`Leídos ${json.caracteres.toLocaleString('es-ES')} caracteres de la web.`)
        router.refresh()
      } else setError(json.error ?? 'No se pudo leer la web.')
    } finally { setLeyendo(false) }
  }

  async function crear() {
    const res = await fetch('/api/sellers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Empresa ${lista.length + 1}` }),
    })
    if (res.ok) {
      const nueva = await res.json()
      setLista([...lista, nueva])
      setActiva(nueva.id)
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="etiqueta">Para quién vendes</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Empresas</h1>
          <p className="mt-1 max-w-2xl text-sm text-apagado">
            El playbook es el <em>método</em> de venta; esto es el <em>contexto</em>. El mismo
            método sirve para varios clientes: lo que cambia es qué vende cada uno. Cada campaña
            apunta a una empresa de aquí.
          </p>
        </div>
        <button type="button" onClick={crear} className="border border-linea-fuerte px-3 py-2 text-sm hover:border-tinta">
          Nueva empresa
        </button>
      </header>

      {lista.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {lista.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => { setActiva(x.id); setAviso(null); setError(null) }}
              className={`border px-3 py-1.5 text-sm ${
                activa === x.id ? 'border-tinta bg-tinta text-lienzo' : 'border-linea-fuerte text-apagado hover:border-tinta'
              }`}
            >
              {x.name}
            </button>
          ))}
        </div>
      )}

      {!e ? (
        <div className="border border-dashed border-linea-fuerte p-10 text-center">
          <p className="text-sm text-tenue">
            No hay ninguna empresa. Crea una y el agente sabrá para quién habla.
          </p>
        </div>
      ) : (
        <div className="space-y-5 border border-linea bg-lienzo p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="nombre" className="etiqueta">Nombre</label>
              <p className="mt-0.5 text-xs text-tenue">Sustituye a <code className="font-mono">{'{{empresa}}'}</code> en el playbook.</p>
              <input id="nombre" value={e.name} onChange={(ev) => actualizar({ name: ev.target.value })} className={`${entrada} mt-1.5`} />
            </div>
            <div>
              <label htmlFor="web" className="etiqueta">Web</label>
              <p className="mt-0.5 text-xs text-tenue">De aquí se saca el contexto automáticamente.</p>
              <input
                id="web" value={e.website ?? ''} placeholder="https://thecotocompany.com"
                onChange={(ev) => actualizar({ website: ev.target.value })}
                className={`${entrada} mt-1.5`}
              />
            </div>
          </div>

          <div>
            <label htmlFor="ctx" className="etiqueta">Contexto que escribes tú</label>
            <p className="mt-0.5 text-xs text-tenue">
              Lo que el agente debe saber y no está en la web: matices, lo que NO decir, casos de
              éxito concretos. Si esto contradice a la web, manda esto.
            </p>
            <textarea
              id="ctx" rows={7} value={e.context ?? ''}
              onChange={(ev) => actualizar({ context: ev.target.value })}
              className={`${entrada} mt-1.5 resize-y`}
            />
          </div>

          <div>
            <label htmlFor="oferta" className="etiqueta">Oferta (opcional)</label>
            <p className="mt-0.5 text-xs text-tenue">Si la rellenas, sustituye a la del playbook para esta empresa.</p>
            <textarea
              id="oferta" rows={4} value={e.offer ?? ''}
              onChange={(ev) => actualizar({ offer: ev.target.value })}
              className={`${entrada} mt-1.5 resize-y`}
            />
          </div>

          <div className="border-t border-linea pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button" onClick={guardarEmpresa} disabled={guardando}
                className="bg-tinta px-4 py-2.5 text-sm font-semibold text-lienzo disabled:opacity-40"
              >
                {guardando ? 'Guardando…' : 'Guardar'}
              </button>
              <button
                type="button" onClick={leerWeb} disabled={leyendo || !e.website}
                className="border border-linea-fuerte px-4 py-2.5 text-sm hover:border-tinta disabled:opacity-40"
              >
                {leyendo ? 'Leyendo la web…' : 'Leer mi web'}
              </button>
              {aviso && <p className="text-sm text-ok">{aviso}</p>}
              {error && <p className="text-sm text-vivo">{error}</p>}
            </div>
            {leyendo && (
              <p className="mt-2 text-xs text-tenue">Tarda entre 20 y 60 segundos.</p>
            )}
          </div>

          {e.scrapedContext && (
            <details className="border-t border-linea pt-4">
              <summary className="etiqueta cursor-pointer hover:text-tinta">
                Lo que se leyó de la web
                {e.scrapedAt && ` · ${new Date(e.scrapedAt).toLocaleDateString('es-ES')}`}
                {` · ${e.scrapedContext.length.toLocaleString('es-ES')} caracteres`}
              </summary>
              <pre className="mt-2 max-h-72 overflow-auto border border-linea bg-papel p-3 font-mono text-[11px] whitespace-pre-wrap text-apagado">
                {e.scrapedContext}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
