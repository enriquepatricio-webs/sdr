'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Cuatro sitios, y punto.
 *
 * Panel es lo que ha pasado, Campañas lo que está en marcha, Leads las personas
 * y Ajustes cómo se comporta el agente. El playbook, el ICP, la prospección y
 * los datos de la empresa siguen existiendo, pero se llega a ellos desde
 * Ajustes: son cosas que se tocan una vez, no todos los días, y tenerlas
 * siempre delante convertía el menú en un inventario.
 */
const RUTAS = [
  { href: '/', etiqueta: 'Panel' },
  { href: '/campaigns', etiqueta: 'Campañas' },
  { href: '/leads', etiqueta: 'Leads' },
  { href: '/settings', etiqueta: 'Ajustes' },
]

export function Navegacion() {
  const ruta = usePathname()
  const rutas = RUTAS

  return (
    <nav className="flex flex-wrap items-center gap-1">
      {rutas.map(({ href, etiqueta }) => {
        const activa = href === '/' ? ruta === '/' : ruta.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            aria-current={activa ? 'page' : undefined}
            className={
              activa
                ? 'rounded-sm bg-tinta px-2.5 py-1 text-sm font-medium text-lienzo'
                : 'rounded-sm px-2.5 py-1 text-sm font-medium text-apagado transition-colors hover:bg-papel hover:text-tinta'
            }
          >
            {etiqueta}
          </Link>
        )
      })}
    </nav>
  )
}
