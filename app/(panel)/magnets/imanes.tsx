'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Cuenta = { id: string; displayName: string; status: string }
type Contacto = { id: string; username: string; state: string }
type Iman = {
  id: string
  name: string
  keyword: string
  postUrl: string
  active: boolean
  cuenta: string
  lastCheckedAt: string | null
  porEstado: Record<string, number>
  contactos: Contacto[]
}

const control =
  'w-full border border-linea-fuerte bg-papel px-2 py-1.5 text-sm outline-none focus:border-ensayo'

const COLOR_ESTADO: Record<string, string> = {
  detectado: 'text-tenue',
  pidiendo_follow: 'text-ensayo',
  verificado: 'text-apagado',
  entregado: 'text-ok',
  en_conversacion: 'text-ok',
  descartado: 'text-tenue',
}

/**
 * Los imanes de Instagram.
 *
 * Deliberadamente corta: palabra clave, los dos mensajes y poco más. Lo que
 * decide el ritmo de envío es el tope horario de la cuenta, y eso ya se
 * configura donde van las cuentas — repetirlo aquí sería un segundo mando para
 * lo mismo.
 */
export function Imanes({
  imanes,
  cuentas,
  estados,
  autopilot,
  empresa,
}: {
  imanes: Iman[]
  cuentas: Cuenta[]
  estados: string[]
  autopilot: boolean
  empresa: string
}) {
  const router = useRouter()
  const [abierto, setAbierto] = useState(false)
  const [ocupado, setOcupado] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)

  async function llamar(url: string, method: string, cuerpo?: unknown) {
    setError(null)
    setAviso(null)
    setOcupado(url)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json.error ?? 'No se pudo completar la acción.')
        return null
      }
      router.refresh()
      return json
    } finally {
      setOcupado(null)
    }
  }

  async function crear(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const creado = await llamar('/api/magnets', 'POST', {
      name: f.get('name'),
      accountId: f.get('accountId'),
      postUrl: f.get('postUrl'),
      keyword: f.get('keyword'),
      followMessage: f.get('followMessage'),
      resource: f.get('resource'),
      pitchMeeting: f.get('pitchMeeting') === 'on',
    })
    if (creado) setAbierto(false)
  }

  async function ejecutar(iman: Iman) {
    const r = await llamar(`/api/magnets/${iman.id}/run`, 'POST')
    if (!r) return
    setAviso(
      `${r.contactosNuevos} nuevos · ${r.peticionesDeFollow} peticiones de follow · ` +
        `${r.verificados} verificados · ${r.entregados} entregados` +
        (r.borradores ? ` · ${r.borradores} borradores sin enviar` : '') +
        (r.sinCupo ? ` · sin cupo: ${r.sinCupo.detalle}` : ''),
    )
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="etiqueta">Imanes de Instagram</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            {imanes.length} {imanes.length === 1 ? 'imán' : 'imanes'}
          </h1>
          <p className="mt-1 text-xs text-tenue">
            Quien comenta la palabra recibe un DM pidiéndole que siga a {empresa}. Cuando sigue, se
            le manda el recurso.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAbierto((v) => !v)}
          className="border border-linea-fuerte px-3 py-1.5 text-sm hover:border-ensayo hover:text-ensayo"
        >
          {abierto ? 'Cancelar' : 'Nuevo imán'}
        </button>
      </header>

      {!autopilot && (
        <p className="border border-ensayo bg-ensayo-suave px-3 py-2 text-xs text-ensayo">
          El autopiloto de {empresa} está apagado: cada ciclo deja los mensajes en borrador y no
          sale nada.
        </p>
      )}
      {error && (
        <p className="border border-vivo bg-vivo-suave px-3 py-2 text-xs text-vivo">{error}</p>
      )}
      {aviso && <p className="border border-linea bg-lienzo px-3 py-2 text-xs text-apagado">{aviso}</p>}

      {abierto && (
        <form onSubmit={crear} className="grid gap-3 border border-linea bg-lienzo p-4 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="etiqueta">Nombre</span>
            <input name="name" required maxLength={120} className={control} />
          </label>
          <label className="space-y-1">
            <span className="etiqueta">Cuenta de Instagram</span>
            <select name="accountId" required className={control}>
              {cuentas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName} {c.status !== 'active' ? `(${c.status})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="etiqueta">URL de la publicación</span>
            <input
              name="postUrl"
              type="url"
              required
              placeholder="https://www.instagram.com/p/..."
              className={control}
            />
          </label>
          <label className="space-y-1">
            <span className="etiqueta">Palabra clave</span>
            <input name="keyword" required maxLength={60} placeholder="GUIA" className={control} />
          </label>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input name="pitchMeeting" type="checkbox" defaultChecked />
            <span>Proponer una llamada después de entregar</span>
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="etiqueta">Mensaje pidiendo el follow</span>
            <textarea name="followMessage" required rows={3} className={control} />
          </label>
          <label className="space-y-1 sm:col-span-2">
            <span className="etiqueta">Recurso (texto o enlace)</span>
            <textarea name="resource" required rows={3} className={control} />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={!cuentas.length || ocupado !== null}
              className="border border-linea-fuerte px-3 py-1.5 text-sm hover:border-ensayo hover:text-ensayo disabled:opacity-40"
            >
              Crear apagado
            </button>
            {!cuentas.length && (
              <span className="ml-3 text-xs text-tenue">
                No hay ninguna cuenta de Instagram conectada.
              </span>
            )}
          </div>
        </form>
      )}

      {imanes.length === 0 ? (
        <div className="border border-dashed border-linea-fuerte p-10 text-center">
          <p className="text-sm text-tenue">Todavía no hay ningún imán.</p>
        </div>
      ) : (
        <ul className="space-y-4">
          {imanes.map((iman) => (
            <li key={iman.id} className="border border-linea bg-lienzo">
              <div className="flex flex-wrap items-center gap-4 border-b border-linea px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {iman.name}{' '}
                    <span className="font-mono text-xs text-ensayo">“{iman.keyword}”</span>
                  </p>
                  <p className="truncate text-xs text-tenue">
                    {iman.cuenta} ·{' '}
                    <a href={iman.postUrl} target="_blank" rel="noreferrer" className="underline">
                      publicación
                    </a>{' '}
                    ·{' '}
                    {iman.lastCheckedAt
                      ? `última lectura ${new Date(iman.lastCheckedAt).toLocaleString('es-ES')}`
                      : 'nunca leída'}
                  </p>
                </div>

                <span
                  className={`font-mono text-[11px] uppercase ${iman.active ? 'text-vivo' : 'text-tenue'}`}
                >
                  {iman.active ? 'activo' : 'apagado'}
                </span>

                <button
                  type="button"
                  disabled={ocupado !== null}
                  onClick={() => llamar(`/api/magnets/${iman.id}`, 'PATCH', { active: !iman.active })}
                  className="border border-linea-fuerte px-2 py-1 text-xs hover:border-ensayo hover:text-ensayo disabled:opacity-40"
                >
                  {iman.active ? 'Apagar' : 'Activar'}
                </button>
                <button
                  type="button"
                  disabled={ocupado !== null || !iman.active}
                  onClick={() => ejecutar(iman)}
                  className={`border px-2 py-1 text-xs disabled:opacity-40 ${
                    autopilot
                      ? 'border-vivo text-vivo hover:bg-vivo-suave'
                      : 'border-ensayo text-ensayo hover:bg-ensayo-suave'
                  }`}
                >
                  {ocupado?.endsWith('/run') ? 'Ejecutando…' : autopilot ? 'Ejecutar y enviar' : 'Ejecutar en borrador'}
                </button>
                <button
                  type="button"
                  disabled={ocupado !== null}
                  onClick={() => llamar(`/api/magnets/${iman.id}`, 'DELETE')}
                  className="border border-linea-fuerte px-2 py-1 text-xs text-tenue hover:border-vivo hover:text-vivo disabled:opacity-40"
                >
                  Borrar
                </button>
              </div>

              <div className="flex flex-wrap gap-4 px-4 py-2 text-xs">
                {estados.map((e) => (
                  <span key={e} className={COLOR_ESTADO[e] ?? 'text-tenue'}>
                    {e.replace('_', ' ')}{' '}
                    <span className="font-mono">{iman.porEstado[e] ?? 0}</span>
                  </span>
                ))}
              </div>

              {iman.contactos.length > 0 && (
                <ul className="max-h-64 divide-y divide-linea overflow-y-auto border-t border-linea">
                  {iman.contactos.map((c) => (
                    <li key={c.id} className="flex items-center justify-between px-4 py-1.5 text-sm">
                      <span className="font-mono text-xs">@{c.username}</span>
                      <span
                        className={`font-mono text-[11px] uppercase ${COLOR_ESTADO[c.state] ?? 'text-tenue'}`}
                      >
                        {c.state.replace('_', ' ')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
