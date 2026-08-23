'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

export function CerrarSesion() {
  const router = useRouter()
  const [saliendo, empezar] = useTransition()

  return (
    <button
      type="button"
      disabled={saliendo}
      onClick={() =>
        empezar(async () => {
          await fetch('/api/auth/logout', { method: 'POST' })
          router.replace('/login')
          router.refresh()
        })
      }
      className="etiqueta transition-colors hover:text-tinta disabled:opacity-50"
    >
      {saliendo ? 'Saliendo…' : 'Salir'}
    </button>
  )
}
