'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { SendingWindow } from '@/lib/db/schema'

type Campana = {
  id: string
  name: string
  status: 'draft' | 'running' | 'paused' | 'done'
  channel: 'linkedin' | 'email' | 'instagram'
  accountId: string | null
  playbookId: string | null
  icpId: string | null
  sellerId: string | null
  dailyCap: number
  maxTouches: number
  followupDelays: number[]
  sendingWindow: SendingWindow
  createdAt: string
}

const entrada = 'w-full border border-linea-fuerte bg-papel px-3 py-2 text-sm outline-none focus:border-ensayo'
const DIAS = [
  { n: 1, l: 'L' }, { n: 2, l: 'M' }, { n: 3, l: 'X' }, { n: 4, l: 'J' },
  { n: 5, l: 'V' }, { n: 6, l: 'S' }, { n: 7, l: 'D' },
]
const ZONAS = ['Europe/Madrid', 'Atlantic/Canary', 'America/Mexico_City', 'America/Bogota', 'America/Argentina/Buenos_Aires', 'UTC']

export function DetalleCampana({
  campana: inicial,
  cuentas,
  playbooks,
  icps,
  empresas,
}: {
  campana: Campana
  cuentas: { id: string; displayName: string; provider: string; status: string }[]
  playbooks: { id: string; name: string; version: number; isActive: boolean }[]
  icps: { id: string; name: string }[]
  empresas: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [c, setC] = useState(inicial)
  const [guardando, guardar] = useTransition()
  const [aviso, setAviso] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Solo se ofrecen cuentas del mismo canal: la clave ajena compuesta rechaza
  // lo demás, y es mejor no dejar elegir algo que no se va a poder guardar.
  const cuentasValidas = cuentas.filter((a) => a.provider === c.channel)

  function guardarCambios() {
    guardar(async () => {
      setAviso(null); setError(null)
      const res = await fetch(`/api/campaigns/${c.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: c.name, channel: c.channel, accountId: c.accountId,
          playbookId: c.playbookId, icpId: c.icpId, sellerId: c.sellerId, dailyCap: c.dailyCap,
          maxTouches: c.maxTouches, followupDelays: c.followupDelays, sendingWindow: c.sendingWindow,
        }),
      })
      const json = await res.json()
      if (res.ok) { setAviso('Guardado.'); router.refresh() } else setError(json.error ?? 'No se pudo guardar.')
    })
  }

  function cambiarEstado(status: Campana['status']) {
    guardar(async () => {
      setAviso(null); setError(null)
      const res = await fetch(`/api/campaigns/${c.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const json = await res.json()
      if (res.ok) { setC({ ...c, status }); router.refresh() } else setError(json.error ?? 'No se pudo cambiar.')
    })
  }

  const enMarcha = c.status === 'running'

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="etiqueta">Campaña</p>
          <input
            value={c.name}
            onChange={(e) => setC({ ...c, name: e.target.value })}
            aria-label="Nombre de la campaña"
            className="mt-1 w-full max-w-lg border-0 border-b border-linea bg-transparent pb-1 text-3xl font-semibold tracking-tight outline-none focus:border-ensayo"
          />
        </div>
        <div className="flex items-center gap-2">
          {enMarcha ? (
            <button
              type="button"
              onClick={() => cambiarEstado('paused')}
              disabled={guardando}
              className="border-2 border-aviso px-4 py-2.5 text-sm font-semibold text-aviso hover:bg-aviso hover:text-white disabled:opacity-50"
            >
              Pausar
            </button>
          ) : (
            <button
              type="button"
              onClick={() => cambiarEstado('running')}
              disabled={guardando}
              className="border-2 border-vivo px-4 py-2.5 text-sm font-bold text-vivo uppercase hover:bg-vivo hover:text-white disabled:opacity-50"
            >
              Activar
            </button>
          )}
          <span className="font-mono text-[11px] uppercase text-tenue">{c.status}</span>
        </div>
      </header>

      {enMarcha && (
        <p className="border-l-2 border-vivo bg-vivo-suave px-4 py-2 text-sm text-vivo">
          Esta campaña está viva. Los cambios de aquí abajo afectan al siguiente lote.
        </p>
      )}
      {error && <p className="border-l-2 border-vivo bg-vivo-suave px-4 py-2 text-sm text-vivo">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-4 border border-linea bg-lienzo p-4">
          <h2 className="etiqueta">Por dónde y con qué</h2>

          <div>
            <label htmlFor="canal" className="etiqueta">Canal</label>
            <select
              id="canal"
              value={c.channel}
              onChange={(e) => setC({ ...c, channel: e.target.value as Campana['channel'], accountId: null })}
              className={`${entrada} mt-1.5`}
            >
              <option value="linkedin">LinkedIn</option>
              <option value="instagram">Instagram</option>
              <option value="email">Email</option>
            </select>
          </div>

          <div>
            <label htmlFor="cuenta" className="etiqueta">Cuenta de envío</label>
            <select
              id="cuenta"
              value={c.accountId ?? ''}
              onChange={(e) => setC({ ...c, accountId: e.target.value || null })}
              className={`${entrada} mt-1.5`}
            >
              <option value="">— sin cuenta —</option>
              {cuentasValidas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName} {a.status !== 'active' ? `(${a.status})` : ''}
                </option>
              ))}
            </select>
            {cuentasValidas.length === 0 && (
              <p className="mt-1 text-xs text-aviso">
                No hay ninguna cuenta de {c.channel}. Conéctala en Ajustes.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="playbook" className="etiqueta">Playbook</label>
            <select
              id="playbook"
              value={c.playbookId ?? ''}
              onChange={(e) => setC({ ...c, playbookId: e.target.value || null })}
              className={`${entrada} mt-1.5`}
            >
              <option value="">— sin playbook —</option>
              {playbooks.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} v{p.version}{p.isActive ? ' (activa)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="empresa" className="etiqueta">Empresa para la que se vende</label>
            <select
              id="empresa"
              value={c.sellerId ?? ''}
              onChange={(e) => setC({ ...c, sellerId: e.target.value || null })}
              className={`${entrada} mt-1.5`}
            >
              <option value="">— sin empresa —</option>
              {empresas.map((x) => (
                <option key={x.id} value={x.id}>{x.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="icp" className="etiqueta">ICP</label>
            <select
              id="icp"
              value={c.icpId ?? ''}
              onChange={(e) => setC({ ...c, icpId: e.target.value || null })}
              className={`${entrada} mt-1.5`}
            >
              <option value="">— sin ICP —</option>
              {icps.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </div>
        </section>

        <section className="space-y-4 border border-linea bg-lienzo p-4">
          <h2 className="etiqueta">Ritmo</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="cap" className="etiqueta">Tope diario</label>
              <p className="mt-0.5 text-xs text-tenue">Máximo 80, y nunca por encima del de la cuenta.</p>
              <input
                id="cap" type="number" min={1} max={80} value={c.dailyCap}
                onChange={(e) => setC({ ...c, dailyCap: Number(e.target.value) })}
                className={`${entrada} mt-1.5 font-mono`}
              />
            </div>
            <div>
              <label htmlFor="toques" className="etiqueta">Toques máximos</label>
              <p className="mt-0.5 text-xs text-tenue">Incluido el primero.</p>
              <input
                id="toques" type="number" min={1} max={10} value={c.maxTouches}
                onChange={(e) => setC({ ...c, maxTouches: Number(e.target.value) })}
                className={`${entrada} mt-1.5 font-mono`}
              />
            </div>
          </div>

          <div>
            <label htmlFor="delays" className="etiqueta">Días entre toques</label>
            <p className="mt-0.5 text-xs text-tenue">Separados por comas. Ejemplo: 3, 5, 7.</p>
            <input
              id="delays"
              value={c.followupDelays.join(', ')}
              onChange={(e) =>
                setC({
                  ...c,
                  followupDelays: e.target.value.split(',').map((s) => Number(s.trim())).filter((n) => n > 0),
                })
              }
              className={`${entrada} mt-1.5 font-mono`}
            />
          </div>

          <div>
            <p className="etiqueta">Ventana de envío</p>
            <p className="mt-0.5 text-xs text-tenue">En la hora del prospecto, no en la tuya.</p>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              <input
                type="time" value={c.sendingWindow.from} aria-label="Desde"
                onChange={(e) => setC({ ...c, sendingWindow: { ...c.sendingWindow, from: e.target.value } })}
                className={`${entrada} font-mono`}
              />
              <input
                type="time" value={c.sendingWindow.to} aria-label="Hasta"
                onChange={(e) => setC({ ...c, sendingWindow: { ...c.sendingWindow, to: e.target.value } })}
                className={`${entrada} font-mono`}
              />
              <select
                value={c.sendingWindow.tz} aria-label="Zona horaria"
                onChange={(e) => setC({ ...c, sendingWindow: { ...c.sendingWindow, tz: e.target.value } })}
                className={entrada}
              >
                {ZONAS.map((z) => (
                  <option key={z} value={z}>{z.split('/').pop()}</option>
                ))}
              </select>
            </div>
            <div className="mt-2 flex gap-1">
              {DIAS.map(({ n, l }) => {
                const on = c.sendingWindow.days.includes(n)
                return (
                  <button
                    key={n} type="button" aria-pressed={on}
                    onClick={() =>
                      setC({
                        ...c,
                        sendingWindow: {
                          ...c.sendingWindow,
                          days: on
                            ? c.sendingWindow.days.filter((d) => d !== n)
                            : [...c.sendingWindow.days, n].sort(),
                        },
                      })
                    }
                    className={`h-9 w-9 border font-mono text-sm ${
                      on ? 'border-tinta bg-tinta text-lienzo' : 'border-linea-fuerte text-tenue hover:border-tinta'
                    }`}
                  >
                    {l}
                  </button>
                )
              })}
            </div>
          </div>
        </section>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button" onClick={guardarCambios} disabled={guardando}
          className="bg-tinta px-4 py-2.5 text-sm font-semibold text-lienzo disabled:opacity-40"
        >
          {guardando ? 'Guardando…' : 'Guardar'}
        </button>
        {aviso && <p className="text-sm text-ok">{aviso}</p>}
      </div>
    </div>
  )
}
