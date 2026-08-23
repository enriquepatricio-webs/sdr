'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const RUTAS = [
  { href: '/', etiqueta: 'Panel' },
  { href: '/playbook', etiqueta: 'Playbook' },
  { href: '/icp', etiqueta: 'ICP' },
  { href: '/prospectar', etiqueta: 'Prospectar' },
  { href: '/campaigns', etiqueta: 'Campañas' },
  { href: '/leads', etiqueta: 'Leads' },
  { href: '/meetings', etiqueta: 'Reuniones' },
  { href: '/settings', etiqueta: 'Ajustes' },
]

export function Navegacion() {
  const ruta = usePathname()

  return (
    <nav className="flex flex-wrap items-center gap-1">
      {RUTAS.map(({ href, etiqueta }) => {
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
