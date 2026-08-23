'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Parada de emergencia.
 *
 * Pide confirmación porque reanudar es campaña a campaña, a mano. Es rojo
 * porque en esta aplicación el rojo significa una sola cosa: hay personas
 * reales al otro lado.
 */
export function ParadaDeEmergencia({ campanasActivas }: { campanasActivas: number }) {
  const router = useRouter()
  const [confirmando, setConfirmando] = useState(false)
  const [parando, parar] = useTransition()
  const [resultado, setResultado] = useState<string | null>(null)

  if (resultado) {
    return <p className="text-sm text-vivo">{resultado}</p>
  }

  if (!confirmando) {
    return (
      <button
        type="button"
        onClick={() => setConfirmando(true)}
        disabled={campanasActivas === 0}
        className="border-2 border-vivo px-5 py-3 text-sm font-bold tracking-wide text-vivo uppercase transition-colors hover:bg-vivo hover:text-white disabled:border-linea-fuerte disabled:text-tenue disabled:hover:bg-transparent disabled:hover:text-tenue"
      >
        Parar todo
      </button>
    )
  }

  return (
    <div className="border-2 border-vivo bg-vivo-suave p-3">
      <p className="text-sm font-medium text-vivo">
        Se pausan las {campanasActivas} campañas activas y se apaga el autopiloto.
      </p>
      <p className="mt-0.5 text-xs text-vivo/80">Reanudar es campaña a campaña.</p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={parando}
          onClick={() =>
            parar(async () => {
              const res = await fetch('/api/campaigns/kill', { method: 'POST' })
              const json = await res.json()
              setResultado(
                res.ok ? `Parado. ${json.pausadas} campañas pausadas.` : 'No se pudo parar.',
              )
              router.refresh()
            })
          }
          className="bg-vivo px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          {parando ? 'Parando…' : 'Sí, parar'}
        </button>
        <button
          type="button"
          onClick={() => setConfirmando(false)}
          className="px-3 py-2 text-sm text-apagado hover:text-tinta"
        >
          Cancelar
        </button>
      </div>
    </div>
  )
}
