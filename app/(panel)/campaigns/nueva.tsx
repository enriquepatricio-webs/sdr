'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Cuenta = { id: string; displayName: string; provider: 'linkedin' | 'email' | 'instagram' }

/** Mismo aspecto que el resto de formularios: se comparte el string, no el CSS. */
const entrada =
  'w-full border border-linea-fuerte bg-papel px-3 py-2 text-sm outline-none focus:border-ensayo'
const boton = 'bg-tinta px-4 py-2.5 text-sm font-semibold text-lienzo disabled:opacity-40'

const CANAL: Record<Cuenta['provider'], string> = {
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  email: 'Email',
}

/**
 * Crear una campaña. Solo pide lo que no se puede adivinar: cómo se llama y
 * desde qué cuenta sale.
 *
 * El canal lo decide la cuenta, no un desplegable aparte: elegir "Instagram" y
 * una cuenta de LinkedIn era un error que solo aparecía al guardar, traducido
 * desde una clave ajena de Postgres.
 */
export function NuevaCampana({ cuentas }: { cuentas: Cuenta[] }) {
  const router = useRouter()
  const [abierto, setAbierto] = useState(false)
  const [nombre, setNombre] = useState('')
  const [cuentaId, setCuentaId] = useState(cuentas[0]?.id ?? '')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')

  async function crear(e: React.FormEvent) {
    e.preventDefault()
    const cuenta = cuentas.find((c) => c.id === cuentaId)
    if (!cuenta) return setError('Elige una cuenta.')

    setGuardando(true)
    setError('')
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nombre, channel: cuenta.provider, accountId: cuenta.id }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'No se pudo crear.')
      router.push(`/campaigns/${json.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear.')
      setGuardando(false)
    }
  }

  if (!cuentas.length) {
    return (
      <p className="text-sm text-apagado">
        Conecta una cuenta en Ajustes → La empresa para poder crear campañas.
      </p>
    )
  }

  if (!abierto) {
    return (
      <button type="button" onClick={() => setAbierto(true)} className={boton}>
        Nueva campaña
      </button>
    )
  }

  return (
    <form onSubmit={crear} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="etiqueta">Nombre</span>
        <input
          autoFocus
          required
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          placeholder="Fundadores B2B · Madrid"
          className={`${entrada} w-64`}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="etiqueta">Desde</span>
        <select
          value={cuentaId}
          onChange={(e) => setCuentaId(e.target.value)}
          className={`${entrada} w-56`}
        >
          {cuentas.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName} · {CANAL[c.provider]}
            </option>
          ))}
        </select>
      </label>

      <button type="submit" disabled={guardando} className={boton}>
        {guardando ? 'Creando…' : 'Crear en borrador'}
      </button>
      <button type="button" onClick={() => setAbierto(false)} className="text-sm text-apagado">
        Cancelar
      </button>

      {error && <p className="w-full text-sm text-vivo">{error}</p>}
    </form>
  )
}
