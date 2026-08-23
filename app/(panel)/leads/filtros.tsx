'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

const ESTADOS = [
  'nuevo', 'contactado', 'en_seguimiento', 'respondido', 'cualificando',
  'cualificado', 'agendado', 'descartado', 'no_interesado', 'revision_humana', 'error',
]

const control = 'border border-linea-fuerte bg-lienzo px-2 py-1.5 text-sm outline-none focus:border-ensayo'

export function Filtros({
  campanas,
  actuales,
}: {
  campanas: { id: string; name: string }[]
  actuales: { estado?: string; campana?: string; score?: string; q?: string }
}) {
  const router = useRouter()
  const [q, setQ] = useState(actuales.q ?? '')

  function ir(cambios: Record<string, string>) {
    const p = new URLSearchParams(
      Object.entries({ ...actuales, ...cambios, p: '' }).filter(([, v]) => v) as [string, string][],
    )
    router.push(`/leads?${p}`)
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); ir({ q }) }}
      className="flex flex-wrap items-center gap-2"
    >
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Buscar por nombre, empresa o titular"
        aria-label="Buscar leads"
        className={`${control} min-w-56 flex-1`}
      />
      <select
        value={actuales.estado ?? ''}
        onChange={(e) => ir({ estado: e.target.value })}
        aria-label="Filtrar por estado"
        className={control}
      >
        <option value="">Todos los estados</option>
        {ESTADOS.map((e) => (
          <option key={e} value={e}>{e.replace('_', ' ')}</option>
        ))}
      </select>
      <select
        value={actuales.campana ?? ''}
        onChange={(e) => ir({ campana: e.target.value })}
        aria-label="Filtrar por campaña"
        className={control}
      >
        <option value="">Todas las campañas</option>
        {campanas.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <select
        value={actuales.score ?? ''}
        onChange={(e) => ir({ score: e.target.value })}
        aria-label="Filtrar por score mínimo"
        className={control}
      >
        <option value="">Cualquier score</option>
        {[40, 60, 70, 80].map((s) => (
          <option key={s} value={String(s)}>{s} o más</option>
        ))}
      </select>
      {(actuales.estado || actuales.campana || actuales.score || actuales.q) && (
        <button type="button" onClick={() => router.push('/leads')} className="etiqueta hover:text-tinta">
          Limpiar
        </button>
      )}
    </form>
  )
}
