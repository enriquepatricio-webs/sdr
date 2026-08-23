'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'

export function Intervenir({ leadId, congelado }: { leadId: string; congelado: boolean }) {
  const router = useRouter()
  const [cambiando, cambiar] = useTransition()

  function alternar() {
    cambiar(async () => {
      await fetch(`/api/leads/${leadId}/intervene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ congelar: !congelado }),
      })
      router.refresh()
    })
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={alternar}
        disabled={cambiando}
        className={
          congelado
            ? 'border border-linea-fuerte px-3 py-2 text-sm font-medium text-apagado hover:border-tinta hover:text-tinta disabled:opacity-50'
            : 'border-2 border-aviso px-3 py-2 text-sm font-semibold text-aviso transition-colors hover:bg-aviso hover:text-white disabled:opacity-50'
        }
      >
        {cambiando ? '…' : congelado ? 'Devolver al agente' : 'Intervenir'}
      </button>
      <p className="mt-1 max-w-48 text-xs text-tenue">
        {congelado
          ? 'El agente no toca este lead.'
          : 'Congela al agente en este lead y lo pasa a revisión.'}
      </p>
    </div>
  )
}
