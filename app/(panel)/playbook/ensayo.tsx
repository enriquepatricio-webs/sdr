'use client'

import { useState } from 'react'

export type PeticionEnsayo = {
  mensaje: string
  historial: { role: 'assistant' | 'user'; content: string }[]
}

export type ResultadoEnsayo = {
  respuesta: string
  modelo: string
  costeUsd: number | null
  tokens: { entrada: number; salida: number }
  latenciaMs: number
  systemPrompt: string
}

/**
 * Frases con las que de verdad te contestan en frío. Son atajos, no un guion:
 * el campo de texto sigue abierto para escribir cualquier cosa.
 */
const ATAJOS = [
  'No me interesa, gracias',
  '¿Cuánto cuesta?',
  'Mándame información por email',
  '¿Esto es un bot?',
  'Ahora mismo vamos a tope, no podemos con más',
  'Quién eres y de dónde has sacado mis datos',
]

function euros(usd: number | null): string {
  if (usd === null) return '—'
  return usd < 0.01 ? `${(usd * 100).toFixed(3)} ¢` : `${usd.toFixed(4)} $`
}

export function PanelEnsayo({
  onProbar,
  cargando,
  resultado,
  error,
}: {
  onProbar: (peticion: PeticionEnsayo) => void
  cargando: boolean
  resultado: ResultadoEnsayo | null
  error: string | null
}) {
  const [mensaje, setMensaje] = useState(ATAJOS[0])
  const [verPrompt, setVerPrompt] = useState(false)

  return (
    <section className="border border-ensayo/25 bg-lienzo" aria-labelledby="titulo-ensayo">
      {/* Franja de identidad: esto es un simulacro y se dice antes que nada. */}
      <div className="flex items-baseline justify-between bg-ensayo px-4 py-2">
        <h2 id="titulo-ensayo" className="font-mono text-[11px] font-bold tracking-[0.16em] text-white uppercase">
          Ensayo
        </h2>
        <p className="font-mono text-[11px] text-white/70">no sale de esta pantalla</p>
      </div>

      <div className="p-4">
        <label htmlFor="mensaje-prospecto" className="etiqueta">
          Qué te contesta el prospecto
        </label>
        <textarea
          id="mensaje-prospecto"
          value={mensaje}
          onChange={(e) => setMensaje(e.target.value)}
          rows={2}
          className="mt-1.5 w-full resize-y border border-linea-fuerte bg-papel px-3 py-2 text-sm outline-none focus:border-ensayo"
        />

        <div className="mt-2 flex flex-wrap gap-1.5">
          {ATAJOS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setMensaje(a)}
              className="border border-linea px-2 py-1 text-xs text-apagado transition-colors hover:border-ensayo hover:text-ensayo"
            >
              {a}
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={cargando || !mensaje.trim()}
          onClick={() => onProbar({ mensaje, historial: [] })}
          className="mt-3 w-full bg-ensayo py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {cargando ? 'Preguntando al modelo…' : 'Probar'}
        </button>

        {error && (
          <p className="mt-3 border-l-2 border-vivo bg-vivo-suave px-3 py-2 text-sm text-vivo">
            {error}
          </p>
        )}

        {resultado && (
          <>
            {/* El hilo. Se parece a lo real a propósito: es lo que se está juzgando. */}
            <div className="mt-4 space-y-2 border border-linea bg-papel p-3">
              <div className="flex justify-start">
                <p className="max-w-[85%] rounded-lg rounded-bl-sm bg-linea px-3 py-2 text-sm text-tinta">
                  {mensaje}
                </p>
              </div>
              <div className="flex justify-end">
                <p className="max-w-[85%] rounded-lg rounded-br-sm border border-ensayo/30 bg-ensayo-suave px-3 py-2 text-sm whitespace-pre-wrap text-tinta">
                  {resultado.respuesta}
                </p>
              </div>
            </div>

            <dl className="mt-3 grid grid-cols-3 gap-3 border-t border-linea pt-3">
              <div>
                <dt className="etiqueta">Coste</dt>
                <dd className="font-mono text-sm">{euros(resultado.costeUsd)}</dd>
              </div>
              <div>
                <dt className="etiqueta">Tiempo</dt>
                <dd className="font-mono text-sm">{(resultado.latenciaMs / 1000).toFixed(1)} s</dd>
              </div>
              <div>
                <dt className="etiqueta">Tokens</dt>
                <dd className="font-mono text-sm">
                  {resultado.tokens.entrada}&thinsp;/&thinsp;{resultado.tokens.salida}
                </dd>
              </div>
            </dl>
            <p className="mt-1 font-mono text-[11px] text-tenue">{resultado.modelo}</p>

            <button
              type="button"
              onClick={() => setVerPrompt((v) => !v)}
              className="mt-3 etiqueta hover:text-tinta"
              aria-expanded={verPrompt}
            >
              {verPrompt ? '− Ocultar' : '+ Ver'} el prompt exacto que recibió el modelo
            </button>
            {verPrompt && (
              <pre className="mt-2 max-h-80 overflow-auto border border-linea bg-papel p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-apagado">
                {resultado.systemPrompt}
              </pre>
            )}
          </>
        )}
      </div>
    </section>
  )
}
