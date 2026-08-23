'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { Settings } from '@/lib/settings'

type Cuenta = {
  id: string
  unipileAccountId: string
  provider: 'linkedin' | 'email' | 'instagram'
  displayName: string
  dailyLimit: number
  hourlyLimit: number | null
  status: 'active' | 'paused' | 'disconnected'
  createdAt: string
}

type Modelo = {
  id: string
  name: string
  promptPerMillion: number
  completionPerMillion: number
  contextLength: number
}

const entrada = 'w-full border border-linea-fuerte bg-papel px-3 py-2 text-sm outline-none focus:border-ensayo'

export function Ajustes({
  cuentas: inicial,
  ajustes: ajustesIniciales,
  tieneTelegramEnv,
}: {
  cuentas: Cuenta[]
  ajustes: Settings
  tieneTelegramEnv: boolean
}) {
  const router = useRouter()
  const [cuentas, setCuentas] = useState(inicial)
  const [ajustes, setAjustes] = useState(ajustesIniciales)
  const [modelos, setModelos] = useState<Modelo[] | null>(null)
  const [guardando, guardar] = useTransition()
  const [aviso, setAviso] = useState<string | null>(null)
  const [confirmandoAutopiloto, setConfirmando] = useState(false)
  const [conectando, setConectando] = useState<string | null>(null)
  const [sincronizando, setSincronizando] = useState(false)

  async function conectar(proveedor: 'LINKEDIN' | 'INSTAGRAM' | 'GOOGLE') {
    setConectando(proveedor)
    setAviso(null)
    try {
      const res = await fetch('/api/accounts/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proveedor }),
      })
      const json = await res.json()
      if (!res.ok) { setAviso(json.error ?? 'No se pudo generar el enlace.'); return }
      // Se abre en una pestaña aparte: las credenciales se meten en la pantalla
      // de Unipile, nunca aquí.
      window.open(json.url, '_blank', 'noopener,noreferrer')
      setAviso('Se abrió el asistente de Unipile. Cuando termines, pulsa "Sincronizar".')
    } finally { setConectando(null) }
  }

  async function sincronizar() {
    setSincronizando(true)
    setAviso(null)
    try {
      const res = await fetch('/api/accounts/sync', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) { setAviso(json.error ?? 'No se pudo sincronizar.'); return }
      setAviso(
        json.nuevas.length
          ? `${json.nuevas.length} cuenta(s) nueva(s): ${json.nuevas.join(', ')}. Entran en pausa; actívalas abajo.`
          : `Sin cuentas nuevas (${json.encontradas} vistas en Unipile).`,
      )
      router.refresh()
    } finally { setSincronizando(false) }
  }

  useEffect(() => {
    fetch('/api/openrouter/models')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setModelos(j.modelos))
      .catch(() => setModelos([]))
  }, [])

  function guardarAjustes(cambios: Partial<Settings>) {
    guardar(async () => {
      setAviso(null)
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cambios),
      })
      if (res.ok) {
        setAjustes(await res.json())
        setAviso('Guardado.')
        router.refresh()
      } else setAviso((await res.json()).error ?? 'No se pudo guardar.')
    })
  }

  function guardarCuenta(id: string, cambios: Partial<Cuenta>) {
    guardar(async () => {
      const res = await fetch(`/api/accounts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cambios),
      })
      if (res.ok) {
        const actualizada = await res.json()
        setCuentas(cuentas.map((c) => (c.id === id ? { ...c, ...actualizada } : c)))
        setAviso('Guardado.')
      } else setAviso((await res.json()).error ?? 'No se pudo guardar la cuenta.')
    })
  }

  const modeloActual = modelos?.find((m) => m.id === ajustes.openrouterModel)

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="etiqueta">Ajustes</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Cómo opera el agente</h1>
        </div>
        {aviso && <p className="text-sm text-ok">{aviso}</p>}
      </header>

      {/* Autopiloto: el ajuste con consecuencias. */}
      <section
        className={`border-2 p-5 ${ajustes.autopilot ? 'border-vivo bg-vivo-suave' : 'border-linea bg-lienzo'}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className={`text-lg font-semibold ${ajustes.autopilot ? 'text-vivo' : ''}`}>
              Autopiloto {ajustes.autopilot ? 'encendido' : 'apagado'}
            </h2>
            <p className="mt-1 max-w-lg text-sm text-apagado">
              {ajustes.autopilot
                ? 'El agente envía los mensajes él solo, sin pasar por ti. Los prospectos los reciben en cuanto los escribe.'
                : 'El agente redacta y deja el mensaje en el hilo del lead como borrador. No sale nada hasta que tú lo apruebes.'}
            </p>
          </div>

          {ajustes.autopilot ? (
            <button
              type="button"
              disabled={guardando}
              onClick={() => guardarAjustes({ autopilot: false })}
              className="border-2 border-vivo bg-vivo px-4 py-2.5 text-sm font-bold text-white uppercase disabled:opacity-50"
            >
              Apagar
            </button>
          ) : confirmandoAutopiloto ? (
            <div className="max-w-sm border-2 border-vivo bg-vivo-suave p-3">
              <p className="text-sm font-medium text-vivo">
                A partir de aquí los mensajes salen a personas reales sin que los veas antes.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={guardando}
                  onClick={() => { guardarAjustes({ autopilot: true }); setConfirmando(false) }}
                  className="bg-vivo px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                  Encender
                </button>
                <button type="button" onClick={() => setConfirmando(false)} className="px-3 py-2 text-sm text-apagado">
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmando(true)}
              className="border-2 border-linea-fuerte px-4 py-2.5 text-sm font-semibold hover:border-vivo hover:text-vivo"
            >
              Encender
            </button>
          )}
        </div>
      </section>

      {/* Reabastecimiento: que no se pare nunca. */}
      <section className="border border-linea bg-lienzo p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <h2 className="text-lg font-semibold">
              Buscar leads solo {ajustes.autoProspect ? '· encendido' : '· apagado'}
            </h2>
            <p className="mt-1 text-sm text-apagado">
              Cuando una campaña en marcha se queda sin leads, el sistema busca más él solo en vez
              de pararse. Encendido no para hasta que lo apagues.
            </p>
            <p className="mt-2 text-xs text-tenue">
              Esto llena la cola. No cambia cuántos mensajes salen al día: eso lo siguen decidiendo
              los topes de cada cuenta.
            </p>
          </div>
          <button
            type="button"
            disabled={guardando}
            onClick={() => guardarAjustes({ autoProspect: !ajustes.autoProspect })}
            className={
              ajustes.autoProspect
                ? 'border-2 border-tinta bg-tinta px-4 py-2.5 text-sm font-semibold text-lienzo disabled:opacity-50'
                : 'border-2 border-linea-fuerte px-4 py-2.5 text-sm font-semibold hover:border-tinta disabled:opacity-50'
            }
          >
            {ajustes.autoProspect ? 'Apagar' : 'Encender'}
          </button>
        </div>

        {ajustes.autoProspect && (
          <div className="mt-4 grid gap-4 border-t border-linea pt-4 sm:grid-cols-4">
            {([
              ['autoProspectMinLeads', 'Buscar por debajo de', 'leads pendientes'],
              ['autoProspectMaxSearchesPerDay', 'Búsquedas al día', 'freno de gasto'],
              ['autoProspectMaxItems', 'Perfiles por búsqueda', ''],
              ['autoProspectMinScore', 'Score para entrar solo', 'de 0 a 100'],
            ] as const).map(([clave, etiqueta, nota]) => (
              <label key={clave} className="text-xs">
                <span className="etiqueta">{etiqueta}</span>
                {nota && <span className="mt-0.5 block text-tenue">{nota}</span>}
                <input
                  type="number"
                  min={1}
                  defaultValue={ajustes[clave]}
                  onBlur={(e) => guardarAjustes({ [clave]: Number(e.target.value) })}
                  className={`${entrada} mt-1 font-mono`}
                />
              </label>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-4 border border-linea bg-lienzo p-4">
          <h2 className="etiqueta">Modelo</h2>

          <div>
            <label htmlFor="modelo" className="etiqueta">Modelo de OpenRouter</label>
            {modelos === null ? (
              <p className="mt-1.5 text-sm text-tenue">Cargando catálogo…</p>
            ) : modelos.length === 0 ? (
              <input
                id="modelo"
                value={ajustes.openrouterModel}
                onChange={(e) => setAjustes({ ...ajustes, openrouterModel: e.target.value })}
                onBlur={() => guardarAjustes({ openrouterModel: ajustes.openrouterModel })}
                className={`${entrada} mt-1.5 font-mono`}
              />
            ) : (
              <select
                id="modelo"
                value={ajustes.openrouterModel}
                onChange={(e) => guardarAjustes({ openrouterModel: e.target.value })}
                className={`${entrada} mt-1.5 font-mono`}
              >
                {!modelos.some((m) => m.id === ajustes.openrouterModel) && (
                  <option value={ajustes.openrouterModel}>{ajustes.openrouterModel} (no está en el catálogo)</option>
                )}
                {modelos.map((m) => (
                  <option key={m.id} value={m.id}>{m.id}</option>
                ))}
              </select>
            )}
            {modeloActual && (
              <p className="mt-1.5 text-xs text-tenue">
                {modeloActual.promptPerMillion.toFixed(2)} $ entrada /{' '}
                {modeloActual.completionPerMillion.toFixed(2)} $ salida por millón de tokens ·{' '}
                {(modeloActual.contextLength / 1000).toFixed(0)}k de contexto
              </p>
            )}
            <p className="mt-1 text-xs text-tenue">
              Solo se listan modelos con tools y salidas estructuradas: el agente los necesita.
            </p>
          </div>

          <div>
            <label htmlFor="empresa" className="etiqueta">Nombre de tu empresa</label>
            <p className="mt-0.5 text-xs text-tenue">Sustituye a <code className="font-mono">{'{{empresa}}'}</code> en el playbook.</p>
            <input
              id="empresa"
              value={ajustes.companyName}
              onChange={(e) => setAjustes({ ...ajustes, companyName: e.target.value })}
              onBlur={() => guardarAjustes({ companyName: ajustes.companyName })}
              className={`${entrada} mt-1.5`}
            />
          </div>

          <label className="flex items-start gap-2 border-t border-linea pt-4 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={ajustes.enrichBeforeContact}
              onChange={(e) => guardarAjustes({ enrichBeforeContact: e.target.checked })}
            />
            <span>
              <span className="font-medium">Leer el perfil y la web antes de escribir</span>
              <span className="mt-0.5 block text-xs text-tenue">
                Añade unos 30 s por lead y cuesta unos céntimos, pero es la diferencia entre un
                mensaje que cita algo suyo y uno que parece una plantilla.
              </span>
            </span>
          </label>

          <div>
            <label htmlFor="telegram" className="etiqueta">Chat de Telegram para los avisos</label>
            <p className="mt-0.5 text-xs text-tenue">
              {tieneTelegramEnv
                ? 'Hay uno en las variables de entorno. Lo que pongas aquí manda sobre él.'
                : 'Habla con @userinfobot en Telegram para saber tu chat_id.'}
            </p>
            <input
              id="telegram"
              value={ajustes.telegramChatId}
              onChange={(e) => setAjustes({ ...ajustes, telegramChatId: e.target.value })}
              onBlur={() => guardarAjustes({ telegramChatId: ajustes.telegramChatId })}
              className={`${entrada} mt-1.5 font-mono`}
            />
          </div>
        </section>

        <section className="border border-linea bg-lienzo p-4">
          <h2 className="etiqueta">Cuentas</h2>
          <p className="mt-0.5 text-xs text-tenue">
            Conecta desde aquí. Tus credenciales se meten en la pantalla de Unipile: este
            dashboard no las ve ni las guarda.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {([
              ['LINKEDIN', 'LinkedIn'],
              ['INSTAGRAM', 'Instagram'],
              ['GOOGLE', 'Gmail'],
            ] as const).map(([id, etiqueta]) => (
              <button
                key={id}
                type="button"
                disabled={conectando !== null}
                onClick={() => conectar(id)}
                className="border border-linea-fuerte px-3 py-2 text-sm hover:border-tinta disabled:opacity-40"
              >
                {conectando === id ? 'Abriendo…' : `Conectar ${etiqueta}`}
              </button>
            ))}
            <button
              type="button"
              disabled={sincronizando}
              onClick={sincronizar}
              className="ml-auto border border-linea-fuerte px-3 py-2 text-sm hover:border-tinta disabled:opacity-40"
            >
              {sincronizando ? 'Sincronizando…' : 'Sincronizar'}
            </button>
          </div>

          <p className="mt-2 text-xs text-tenue">
            Las cuentas nuevas entran <strong>en pausa</strong>. Conectar y empezar a escribir en
            el mismo gesto es justo lo que no queremos.
          </p>

          <ul className="mt-3 space-y-4">
            {cuentas.length === 0 && (
              <li className="text-sm text-tenue">Ninguna cuenta conectada todavía.</li>
            )}
            {cuentas.map((c) => (
              <li key={c.id} className="space-y-2 border-t border-linea pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.displayName}</span>
                  <span className="font-mono text-[11px] text-tenue uppercase">{c.provider}</span>
                  <select
                    value={c.status}
                    onChange={(e) => guardarCuenta(c.id, { status: e.target.value as Cuenta['status'] })}
                    aria-label={`Estado de ${c.displayName}`}
                    className={`ml-auto border border-linea-fuerte bg-papel px-2 py-1 text-xs ${
                      c.status === 'active' ? 'text-ok' : 'text-apagado'
                    }`}
                  >
                    <option value="active">activa</option>
                    <option value="paused">en pausa</option>
                    <option value="disconnected">desconectada</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs">
                    <span className="etiqueta">Tope diario</span>
                    <input
                      type="number" min={1} max={80} defaultValue={c.dailyLimit}
                      onBlur={(e) => guardarCuenta(c.id, { dailyLimit: Number(e.target.value) })}
                      className={`${entrada} mt-1 font-mono`}
                    />
                  </label>
                  <label className="text-xs">
                    <span className="etiqueta">Tope por hora</span>
                    <input
                      type="number" min={1} max={20} defaultValue={c.hourlyLimit ?? ''}
                      placeholder="sin tope"
                      onBlur={(e) =>
                        guardarCuenta(c.id, { hourlyLimit: e.target.value ? Number(e.target.value) : null })
                      }
                      className={`${entrada} mt-1 font-mono`}
                    />
                  </label>
                </div>

                {c.provider === 'instagram' && c.hourlyLimit === null && (
                  <p className="text-xs text-aviso">
                    Instagram admite 100 acciones al día pero no más de 10 por hora. Sin tope horario
                    te arriesgas a un bloqueo.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
