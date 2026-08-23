'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CAMPOS_IMPORTABLES, type CampoImportable, adivinarMapeo, parsearCsv } from '@/lib/csv'

type Campana = { id: string; name: string; channel: string }
type Resultado = {
  total: number
  importadas: number
  duplicadas: number
  rechazadas: { fila: number; nombre: string; motivo: string }[]
}

const control = 'border border-linea-fuerte bg-papel px-2 py-1.5 text-sm outline-none focus:border-ensayo'

/**
 * Importador de CSV con mapeo de columnas.
 *
 * El fichero se lee en el navegador y solo se envían las filas ya mapeadas: así
 * el usuario ve exactamente qué se va a importar antes de que nada llegue a la
 * base de datos, y se puede corregir un mapeo mal adivinado sin subir dos veces.
 */
export function Importador({ campanas }: { campanas: Campana[] }) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)

  const [abierto, setAbierto] = useState(false)
  const [filas, setFilas] = useState<Record<string, string>[]>([])
  const [cabeceras, setCabeceras] = useState<string[]>([])
  const [mapeo, setMapeo] = useState<Partial<Record<CampoImportable, string>>>({})
  const [campanaId, setCampanaId] = useState(campanas[0]?.id ?? '')
  const [importando, setImportando] = useState(false)
  const [resultado, setResultado] = useState<Resultado | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function leerFichero(file: File) {
    setError(null)
    setResultado(null)
    const texto = await file.text()
    const parseadas = parsearCsv(texto)
    if (!parseadas.length) {
      setError('Ese fichero no tiene filas de datos, o no es un CSV.')
      return
    }
    const cols = Object.keys(parseadas[0])
    setFilas(parseadas)
    setCabeceras(cols)
    setMapeo(adivinarMapeo(cols))
  }

  async function importar() {
    if (!mapeo.fullName) {
      setError('Hace falta decir qué columna lleva el nombre.')
      return
    }
    setImportando(true)
    setError(null)
    try {
      const cuerpo = filas
        .map((f) =>
          Object.fromEntries(
            CAMPOS_IMPORTABLES.map(({ campo }) => [campo, mapeo[campo] ? f[mapeo[campo]!] : undefined]),
          ),
        )
        .filter((f) => f.fullName)

      const res = await fetch('/api/leads/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId: campanaId, filas: cuerpo }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'No se pudo importar.')
        return
      }
      setResultado(json)
      setFilas([])
      router.refresh()
    } finally {
      setImportando(false)
    }
  }

  if (!abierto) {
    return (
      <button
        type="button"
        onClick={() => setAbierto(true)}
        className="bg-tinta px-4 py-2.5 text-sm font-semibold text-lienzo transition-opacity hover:opacity-90"
      >
        Importar CSV
      </button>
    )
  }

  const campana = campanas.find((c) => c.id === campanaId)

  return (
    <section className="w-full border border-linea bg-lienzo p-4" aria-label="Importar CSV">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Importar CSV</h2>
        <button type="button" onClick={() => setAbierto(false)} className="etiqueta hover:text-tinta">
          Cerrar
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => e.target.files?.[0] && leerFichero(e.target.files[0])}
          className="text-sm file:mr-3 file:border file:border-linea-fuerte file:bg-papel file:px-3 file:py-1.5 file:text-sm"
        />
        <select
          value={campanaId}
          onChange={(e) => setCampanaId(e.target.value)}
          aria-label="Campaña de destino"
          className={control}
        >
          {campanas.map((c) => (
            <option key={c.id} value={c.id}>{c.name} ({c.channel})</option>
          ))}
        </select>
      </div>

      {campana && (
        <p className="mt-2 text-xs text-tenue">
          Esta campaña envía por <strong>{campana.channel}</strong>: los leads sin ese dato se
          rechazan y te digo cuáles.
        </p>
      )}

      {error && (
        <p className="mt-3 border-l-2 border-vivo bg-vivo-suave px-3 py-2 text-sm text-vivo">{error}</p>
      )}

      {filas.length > 0 && (
        <>
          <p className="etiqueta mt-4">
            {filas.length} filas · asigna las columnas
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {CAMPOS_IMPORTABLES.map(({ campo, etiqueta, obligatorio }) => (
              <label key={campo} className="flex items-center gap-2 text-sm">
                <span className="w-40 shrink-0 text-apagado">
                  {etiqueta}
                  {obligatorio && <span className="text-vivo"> *</span>}
                </span>
                <select
                  value={mapeo[campo] ?? ''}
                  onChange={(e) => setMapeo({ ...mapeo, [campo]: e.target.value || undefined })}
                  className={`${control} flex-1`}
                >
                  <option value="">— sin asignar —</option>
                  {cabeceras.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {/* Vista previa: tres filas ya mapeadas, para cazar un mapeo torcido
              antes de escribir nada en la base. */}
          <p className="etiqueta mt-4">Así van a entrar las tres primeras</p>
          <div className="mt-1.5 overflow-x-auto border border-linea">
            <table className="w-full min-w-[40rem] text-xs">
              <thead className="bg-papel">
                <tr>
                  {CAMPOS_IMPORTABLES.filter((c) => mapeo[c.campo]).map((c) => (
                    <th key={c.campo} className="px-2 py-1.5 text-left etiqueta font-normal">
                      {c.etiqueta}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-linea">
                {filas.slice(0, 3).map((f, i) => (
                  <tr key={i}>
                    {CAMPOS_IMPORTABLES.filter((c) => mapeo[c.campo]).map((c) => (
                      <td key={c.campo} className="max-w-48 truncate px-2 py-1.5">
                        {f[mapeo[c.campo]!] || <span className="text-tenue">vacío</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            onClick={importar}
            disabled={importando || !campanaId}
            className="mt-4 bg-tinta px-4 py-2.5 text-sm font-semibold text-lienzo disabled:opacity-40"
          >
            {importando ? 'Importando…' : `Importar ${filas.length} leads`}
          </button>
        </>
      )}

      {resultado && (
        <div className="mt-4 border-l-2 border-ok bg-papel px-3 py-2">
          <p className="text-sm">
            <strong>{resultado.importadas}</strong> importados
            {resultado.duplicadas > 0 && ` · ${resultado.duplicadas} ya estaban`}
            {resultado.rechazadas.length > 0 && ` · ${resultado.rechazadas.length} rechazados`}
          </p>
          {resultado.rechazadas.length > 0 && (
            <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-xs text-apagado">
              {resultado.rechazadas.map((r) => (
                <li key={r.fila}>
                  Fila {r.fila} · {r.nombre}: {r.motivo}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
