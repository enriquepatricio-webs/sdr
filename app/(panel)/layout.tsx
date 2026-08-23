import Link from 'next/link'
import { getSettings } from '@/lib/settings'
import { Navegacion } from './navegacion'
import { CerrarSesion } from './cerrar-sesion'

/**
 * Marco de la aplicación.
 *
 * Si la base de datos no responde todavía, se asume autopiloto APAGADO. Fallar
 * hacia el lado que no envía mensajes es la única opción defendible.
 */
async function leerAutopiloto(): Promise<boolean> {
  try {
    return (await getSettings()).autopilot
  } catch {
    return false
  }
}

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const autopiloto = await leerAutopiloto()

  return (
    <div className="min-h-screen">
      <div className="franja-estado" data-autopiloto={autopiloto ? 'on' : 'off'} aria-hidden />

      <header className="border-b border-linea bg-lienzo">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-8 gap-y-3 px-6 py-3">
          <Link
            href="/"
            className="font-mono text-sm font-bold tracking-[0.18em] text-tinta uppercase"
          >
            SDR
          </Link>

          <Navegacion />

          <div className="ml-auto flex items-center gap-4">
            <Link
              href="/settings"
              className="flex items-center gap-2"
              title="Cambiar el modo de autopiloto"
            >
              <span className="etiqueta">Autopiloto</span>
              <span
                className={
                  autopiloto
                    ? 'rounded-sm bg-vivo px-2 py-0.5 font-mono text-[11px] font-bold tracking-widest text-white uppercase'
                    : 'rounded-sm border border-linea-fuerte px-2 py-0.5 font-mono text-[11px] font-bold tracking-widest text-apagado uppercase'
                }
              >
                {autopiloto ? 'Enviando' : 'Apagado'}
              </span>
            </Link>
            <CerrarSesion />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>
    </div>
  )
}
