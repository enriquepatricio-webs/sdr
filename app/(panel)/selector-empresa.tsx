'use client'

import { useRouter } from 'next/navigation'
import { elegirEmpresa } from '@/lib/empresa'

/**
 * Con qué empresa se está trabajando.
 *
 * El marco solo lo pinta cuando hay más de una: con una sola no hay nada que
 * elegir y un desplegable de un elemento es una pregunta sin respuesta posible.
 *
 * Va con un `select` nativo a propósito. Un desplegable a medida necesitaría
 * teclado, foco, escape, tipo-para-buscar y móvil; el del sistema ya trae todo
 * eso hecho y encima abre la rueda nativa en el teléfono.
 */
export function SelectorEmpresa({
  empresas,
  actual,
}: {
  empresas: { id: string; name: string }[]
  actual: string
}) {
  const router = useRouter()

  return (
    <label className="relative flex items-center">
      <span className="sr-only">Empresa con la que trabajas</span>
      <select
        value={actual}
        onChange={(e) => {
          elegirEmpresa(e.target.value)
          router.refresh()
        }}
        className="cursor-pointer appearance-none rounded-sm border border-linea-fuerte bg-lienzo py-1 pr-7 pl-2.5 text-sm font-medium text-tinta transition-colors hover:border-tinta"
      >
        {empresas.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      <span aria-hidden className="pointer-events-none absolute right-2.5 text-xs text-tenue">
        ▾
      </span>
    </label>
  )
}
