import Link from 'next/link'
import { cookies } from 'next/headers'
import { COOKIE_EMPRESA } from '@/lib/empresa'
import { listarWorkspaces } from '@/lib/workspace'
import { Navegacion } from './navegacion'
import { SelectorEmpresa } from './selector-empresa'
import { CerrarSesion } from './cerrar-sesion'

/**
 * Marco de la aplicación.
 *
 * Si la base de datos no responde todavía, se asume autopiloto APAGADO. Fallar
 * hacia el lado que no envía mensajes es la única opción defendible.
 *
 * El autopiloto que se pinta aquí es el de la empresa con la que se está
 * trabajando, no un global: encenderlo en una no lo enciende en las demás y la
 * franja roja tiene que decir la verdad de lo que hay delante.
 */
async function leerMarco() {
  try {
    const [empresas, galleta] = await Promise.all([listarWorkspaces(), cookies()])
    const elegida = galleta.get(COOKIE_EMPRESA)?.value
    const actual = empresas.find((e) => e.id === elegida) ?? empresas[0] ?? null
    return { empresas, actual, autopiloto: actual?.autopilot ?? false }
  } catch {
    return { empresas: [], actual: null, autopiloto: false }
  }
}

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const { empresas, actual, autopiloto } = await leerMarco()

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
            {empresas.length > 1 && actual && (
              <SelectorEmpresa empresas={empresas} actual={actual.id} />
            )}

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
