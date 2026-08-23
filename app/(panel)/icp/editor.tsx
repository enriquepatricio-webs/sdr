'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { IcpSignal } from '@/lib/db/schema'

type Icp = {
  id: string
  name: string
  description: string | null
  criteria: IcpSignal[]
  disqualifiers: IcpSignal[]
  createdAt: string
}

const entrada = 'w-full border border-linea-fuerte bg-papel px-3 py-2 text-sm outline-none focus:border-ensayo'

function ListaSenales({
  titulo,
  ayuda,
  color,
  senales,
  onChange,
}: {
  titulo: string
  ayuda: string
  color: 'ok' | 'vivo'
  senales: IcpSignal[]
  onChange: (s: IcpSignal[]) => void
}) {
  return (
    <div>
      <p className={`etiqueta ${color === 'ok' ? 'text-ok' : 'text-vivo'}`}>{titulo}</p>
      <p className="mt-0.5 text-xs text-tenue">{ayuda}</p>
      <div className="mt-2 space-y-2">
        {senales.map((s, i) => (
          <div key={i} className={`space-y-1.5 border-l-2 pl-3 ${color === 'ok' ? 'border-ok/40' : 'border-vivo/40'}`}>
            <input
              value={s.signal}
              onChange={(e) => onChange(senales.map((x, j) => (i === j ? { ...x, signal: e.target.value } : x)))}
              aria-label={`${titulo} ${i + 1}`}
              className={entrada}
            />
            <input
              value={s.source ?? ''}
              onChange={(e) => onChange(senales.map((x, j) => (i === j ? { ...x, source: e.target.value } : x)))}
              placeholder="Dónde se ve: headline, web, actividad reciente…"
              aria-label={`Dónde se ve la señal ${i + 1}`}
              className={`${entrada} text-xs`}
            />
            <button
              type="button"
              onClick={() => onChange(senales.filter((_, j) => j !== i))}
              className="etiqueta hover:text-vivo"
            >
              Quitar
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...senales, { id: `senal_${senales.length + 1}`, signal: '' }])}
        className="mt-2 border border-linea-fuerte px-3 py-1.5 text-sm text-apagado hover:border-tinta hover:text-tinta"
      >
        Añadir señal
      </button>
    </div>
  )
}

export function EditorIcp({ inicial }: { inicial: Icp[] }) {
  const router = useRouter()
  const [lista, setLista] = useState(inicial)
  const [activo, setActivo] = useState(inicial[0]?.id ?? null)
  const [guardando, setGuardando] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)

  const icp = lista.find((i) => i.id === activo)

  function actualizar(cambios: Partial<Icp>) {
    setLista(lista.map((i) => (i.id === activo ? { ...i, ...cambios } : i)))
  }

  async function guardar() {
    if (!icp) return
    setGuardando(true)
    setAviso(null)
    const res = await fetch(`/api/icp/${icp.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: icp.name,
        description: icp.description,
        criteria: icp.criteria,
        disqualifiers: icp.disqualifiers,
      }),
    })
    setAviso(res.ok ? 'Guardado.' : ((await res.json()).error ?? 'No se pudo guardar.'))
    setGuardando(false)
    router.refresh()
  }

  async function crear() {
    const res = await fetch('/api/icp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ICP nuevo', criteria: [], disqualifiers: [] }),
    })
    if (res.ok) {
      const nuevo = await res.json()
      setLista([...lista, { ...nuevo, createdAt: nuevo.createdAt }])
      setActivo(nuevo.id)
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="etiqueta">Perfil de cliente ideal</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">A quién buscas</h1>
          <p className="mt-1 max-w-xl text-sm text-apagado">
            Esto entra en el prompt del agente y también es lo que puntúa a los candidatos que
            encuentra Apify.
          </p>
        </div>
        <button
          type="button"
          onClick={crear}
          className="border border-linea-fuerte px-3 py-2 text-sm hover:border-tinta"
        >
          Nuevo ICP
        </button>
      </header>

      {lista.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {lista.map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={() => setActivo(i.id)}
              className={`border px-3 py-1.5 text-sm ${
                activo === i.id ? 'border-tinta bg-tinta text-lienzo' : 'border-linea-fuerte text-apagado hover:border-tinta'
              }`}
            >
              {i.name}
            </button>
          ))}
        </div>
      )}

      {!icp ? (
        <div className="border border-dashed border-linea-fuerte p-10 text-center">
          <p className="text-sm text-tenue">No hay ningún ICP. Crea uno para empezar.</p>
        </div>
      ) : (
        <div className="space-y-6 border border-linea bg-lienzo p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="nombre" className="etiqueta">Nombre</label>
              <input
                id="nombre"
                value={icp.name}
                onChange={(e) => actualizar({ name: e.target.value })}
                className={`${entrada} mt-1.5`}
              />
            </div>
            <div>
              <label htmlFor="desc" className="etiqueta">En una frase</label>
              <input
                id="desc"
                value={icp.description ?? ''}
                onChange={(e) => actualizar({ description: e.target.value })}
                className={`${entrada} mt-1.5`}
              />
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <ListaSenales
              titulo="Encaja si…"
              ayuda="Señales que suman. El agente las busca en el perfil."
              color="ok"
              senales={icp.criteria}
              onChange={(criteria) => actualizar({ criteria })}
            />
            <ListaSenales
              titulo="Descartar de inmediato si…"
              ayuda="Una sola de estas tumba al candidato, por bien que encaje en lo demás."
              color="vivo"
              senales={icp.disqualifiers}
              onChange={(disqualifiers) => actualizar({ disqualifiers })}
            />
          </div>

          <div className="flex items-center gap-3 border-t border-linea pt-4">
            <button
              type="button"
              onClick={guardar}
              disabled={guardando}
              className="bg-tinta px-4 py-2.5 text-sm font-semibold text-lienzo disabled:opacity-40"
            >
              {guardando ? 'Guardando…' : 'Guardar'}
            </button>
            {aviso && <p className="text-sm text-ok">{aviso}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
