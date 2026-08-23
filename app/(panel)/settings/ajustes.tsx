'use client'

import Link from 'next/link'
import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { Settings } from '@/lib/settings'
import { Interruptor } from '@/components/interruptor'
import { ParadaDeEmergencia } from '../parada'

type AjustesEfectivos = Settings & { workspace: { id: string; name: string } | null }

type Modelo = { id: string; promptPerMillion: number; completionPerMillion: number; contextLength: number }

const entrada =
  'w-full border border-linea-fuerte bg-papel px-3 py-2 text-sm outline-none focus:border-ensayo'

/** A dónde se baja cuando de verdad hace falta. No es el camino normal. */
const DETALLE = [
  { href: '/empresa', etiqueta: 'Datos de la empresa', nota: 'contexto, web y oferta' },
  { href: '/playbook', etiqueta: 'Playbook', nota: 'cómo vende el agente' },
  { href: '/icp', etiqueta: 'ICP', nota: 'a quién considera buen cliente' },
  { href: '/prospectar', etiqueta: 'Prospectar a mano', nota: 'buscar leads ahora' },
]

export function Ajustes({
  ajustes: iniciales,
  campanasActivas,
  tieneTelegramEnv,
}: {
  ajustes: AjustesEfectivos
  campanasActivas: number
  tieneTelegramEnv: boolean
}) {
  const router = useRouter()
  const [ajustes, setAjustes] = useState(iniciales)
  const [modelos, setModelos] = useState<Modelo[] | null>(null)
  const [guardando, guardar] = useTransition()
  const [aviso, setAviso] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmandoAutopiloto, setConfirmando] = useState(false)
  const [buscandoChat, setBuscandoChat] = useState(false)
  const [chats, setChats] = useState<{ id: string; tipo: string; nombre: string }[] | null>(null)
  const [pistaChat, setPistaChat] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/openrouter/models')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setModelos(j.modelos))
      .catch(() => setModelos([]))
  }, [])

  function guardarAjustes(cambios: Partial<Settings>) {
    guardar(async () => {
      setAviso(null)
      setError(null)
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cambios, workspaceId: ajustes.workspace?.id }),
      })
      if (res.ok) {
        setAjustes(await res.json())
        setAviso('Guardado.')
        router.refresh()
      } else setError((await res.json()).error ?? 'No se pudo guardar.')
    })
  }

  async function identificarChat() {
    setBuscandoChat(true)
    setChats(null)
    setPistaChat(null)
    try {
      const res = await fetch('/api/telegram/identify')
      const json = await res.json()
      if (!res.ok) {
        setPistaChat(json.error ?? 'No se pudo consultar Telegram.')
        return
      }
      setChats(json.chats ?? [])
      if (!json.chats?.length) {
        setPistaChat(json.pista ?? 'Escríbele /start al bot y vuelve a pulsar.')
      }
    } finally {
      setBuscandoChat(false)
    }
  }

  const modeloActual = modelos?.find((m) => m.id === ajustes.openrouterModel)

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="etiqueta">Ajustes</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Cómo opera el agente</h1>
        </div>
        {aviso && <p className="text-sm text-ok">{aviso}</p>}
        {error && <p className="text-sm text-vivo">{error}</p>}
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Lo que decide cada empresa por su cuenta.                            */}
      {/* ------------------------------------------------------------------ */}
      <section className="space-y-5">
        <h2 className="etiqueta border-b border-linea pb-2">
          {ajustes.workspace ? ajustes.workspace.name : 'Tu empresa'}
        </h2>

        {!ajustes.workspace && (
          <p className="border-l-2 border-aviso bg-papel px-3 py-2 text-sm text-aviso">
            Todavía no has dado de alta ninguna empresa, así que esto no tiene dónde guardarse.{' '}
            <Link href="/empresa" className="underline">
              Empieza por ahí
            </Link>
            .
          </p>
        )}

        {/* El único ajuste con consecuencias irreversibles del sistema. */}
        <div
          className={`border-2 p-5 ${
            ajustes.autopilot ? 'border-vivo bg-vivo-suave' : 'border-linea bg-lienzo'
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-lg">
              <h3 className={`text-lg font-semibold ${ajustes.autopilot ? 'text-vivo' : ''}`}>
                Autopiloto
              </h3>
              <p className="mt-1 text-sm text-apagado">
                {ajustes.autopilot
                  ? 'El agente envía los mensajes él solo. Los prospectos los reciben en cuanto los escribe.'
                  : 'El agente redacta y deja el mensaje como borrador. No sale nada hasta que tú lo apruebes.'}
              </p>
            </div>
            <Interruptor
              etiqueta={ajustes.autopilot ? 'Enviando' : 'Apagado'}
              activo={ajustes.autopilot}
              peligroso
              desactivado={guardando}
              onCambiar={(v) => (v ? setConfirmando(true) : guardarAjustes({ autopilot: false }))}
            />
          </div>

          {confirmandoAutopiloto && !ajustes.autopilot && (
            <div className="mt-4 border-2 border-vivo bg-lienzo p-3">
              <p className="text-sm font-medium text-vivo">
                A partir de aquí los mensajes salen a personas reales sin que los veas antes.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={guardando}
                  onClick={() => {
                    guardarAjustes({ autopilot: true })
                    setConfirmando(false)
                  }}
                  className="bg-vivo px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                  Encender
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
          )}
        </div>

        {/* Telegram: por dónde te avisa. */}
        <div className="border border-linea bg-lienzo p-5">
          <label htmlFor="telegram" className="text-base font-semibold">
            Avisos por Telegram
          </label>
          <p className="mt-0.5 text-sm text-tenue">
            {tieneTelegramEnv
              ? 'Hay uno en el entorno. Lo que pongas aquí manda sobre él.'
              : 'Escríbele algo a tu bot y pulsa Identificar: el número lo saca él.'}
          </p>
          <div className="mt-2 flex gap-2">
            <input
              id="telegram"
              value={ajustes.telegramChatId}
              onChange={(e) => setAjustes({ ...ajustes, telegramChatId: e.target.value })}
              onBlur={() => guardarAjustes({ telegramChatId: ajustes.telegramChatId })}
              className={`${entrada} font-mono`}
            />
            <button
              type="button"
              onClick={identificarChat}
              disabled={buscandoChat}
              className="shrink-0 border border-linea-fuerte px-3 text-sm hover:border-tinta disabled:opacity-40"
            >
              {buscandoChat ? 'Buscando…' : 'Identificar'}
            </button>
          </div>

          {pistaChat && <p className="mt-2 text-xs text-aviso">{pistaChat}</p>}

          {chats && chats.length > 0 && (
            <ul className="mt-2 space-y-1 border border-linea bg-papel p-2">
              {chats.map((c) => (
                <li key={c.id} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 truncate">
                    {c.nombre} <span className="text-tenue">· {c.tipo}</span>
                  </span>
                  <span className="font-mono text-xs text-tenue">{c.id}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setAjustes({ ...ajustes, telegramChatId: c.id })
                      guardarAjustes({ telegramChatId: c.id })
                      setChats(null)
                    }}
                    className="etiqueta hover:text-tinta"
                  >
                    Usar este
                  </button>
                </li>
              ))}
            </ul>
          )}

          {ajustes.telegramChatId && (
            <button
              type="button"
              onClick={async () => {
                const res = await fetch('/api/notify', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ tipo: 'libre', texto: 'Prueba de avisos del SDR.' }),
                })
                setAviso(res.ok ? 'Aviso de prueba enviado.' : null)
                setError(res.ok ? null : 'No llegó: revisa el número.')
              }}
              className="etiqueta mt-2 hover:text-tinta"
            >
              Enviar aviso de prueba
            </button>
          )}
        </div>

        {/* Reabastecimiento: que la cola no se quede vacía. */}
        <div className="border border-linea bg-lienzo p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-lg">
              <h3 className="text-base font-semibold">Buscar leads solo</h3>
              <p className="mt-0.5 text-sm text-apagado">
                Cuando una campaña en marcha se queda sin leads, busca más en vez de pararse. No
                cambia cuántos mensajes salen al día.
              </p>
            </div>
            <Interruptor
              etiqueta={ajustes.autoProspect ? 'Encendido' : 'Apagado'}
              activo={ajustes.autoProspect}
              desactivado={guardando}
              onCambiar={(v) => guardarAjustes({ autoProspect: v })}
            />
          </div>

          {ajustes.autoProspect && (
            <details className="mt-4 border-t border-linea pt-3">
              <summary className="etiqueta cursor-pointer hover:text-tinta">Afinar</summary>
              <div className="mt-3 grid gap-4 sm:grid-cols-3">
                {(
                  [
                    ['autoProspectMinLeads', 'Buscar por debajo de', 'leads pendientes'],
                    ['autoProspectMaxItems', 'Perfiles por búsqueda', ''],
                    ['autoProspectMinScore', 'Score para entrar solo', 'de 0 a 100'],
                  ] as const
                ).map(([clave, etiqueta, nota]) => (
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
            </details>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Lo que se decide una vez para todo, no por empresa.                  */}
      {/* ------------------------------------------------------------------ */}
      <section className="space-y-5">
        <h2 className="etiqueta border-b border-linea pb-2">Todo el sistema</h2>

        <div className="space-y-5 border border-linea bg-lienzo p-5">
          <div>
            <label htmlFor="modelo" className="text-base font-semibold">
              Modelo
            </label>
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
                  <option value={ajustes.openrouterModel}>
                    {ajustes.openrouterModel} (no está en el catálogo)
                  </option>
                )}
                {modelos.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
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
          </div>

          <div className="flex flex-wrap items-start justify-between gap-4 border-t border-linea pt-5">
            <div className="max-w-lg">
              <h3 className="text-base font-semibold">Leer el perfil antes de escribir</h3>
              <p className="mt-0.5 text-sm text-apagado">
                Unos 30 s y unos céntimos por lead. Es la diferencia entre citar algo suyo y
                parecer una plantilla.
              </p>
            </div>
            <Interruptor
              etiqueta={ajustes.enrichBeforeContact ? 'Sí' : 'No'}
              activo={ajustes.enrichBeforeContact}
              desactivado={guardando}
              onCambiar={(v) => guardarAjustes({ enrichBeforeContact: v })}
            />
          </div>

          <div className="border-t border-linea pt-5">
            <label htmlFor="tope" className="text-base font-semibold">
              Tope de búsquedas al día
            </label>
            <p className="mt-0.5 text-sm text-apagado">
              Freno de gasto de todo el sistema. Vale para todas las empresas juntas: si fuese de
              cada una, cinco empresas multiplicarían la factura por cinco.
            </p>
            <input
              id="tope"
              type="number"
              min={1}
              max={50}
              defaultValue={ajustes.autoProspectMaxSearchesPerDay}
              onBlur={(e) =>
                guardarAjustes({ autoProspectMaxSearchesPerDay: Number(e.target.value) })
              }
              className={`${entrada} mt-2 w-24 font-mono`}
            />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-wrap items-center justify-between gap-4 border-2 border-vivo bg-lienzo p-5">
        <div className="max-w-lg">
          <h2 className="text-lg font-semibold text-vivo">Parada de emergencia</h2>
          <p className="mt-0.5 text-sm text-apagado">
            Pausa todas las campañas y apaga el autopiloto de todas las empresas. Es de ida
            solamente: reanudar se hace campaña a campaña, a mano.
          </p>
        </div>
        <ParadaDeEmergencia campanasActivas={campanasActivas} />
      </section>

      <section>
        <h2 className="etiqueta border-b border-linea pb-2">Si quieres bajar al detalle</h2>
        <ul className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {DETALLE.map(({ href, etiqueta, nota }) => (
            <li key={href}>
              <Link href={href} className="text-sm text-apagado hover:text-tinta">
                {etiqueta} <span className="text-tenue">· {nota}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
