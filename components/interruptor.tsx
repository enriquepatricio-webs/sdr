'use client'

/**
 * Interruptor de encendido/apagado.
 *
 * Adaptado de "Toggle Switch" de prebuiltui (21st.dev) a los tokens de la casa.
 * Se queda con lo bueno del original —un checkbox de verdad debajo, así que
 * funciona con teclado y lo anuncian los lectores de pantalla— y se le quitan
 * los índigos y los grises de fuera.
 *
 * `peligroso` pinta el encendido con `--color-vivo`. Ese rojo no decora: dice
 * que lo que se acaba de encender llega a una persona real.
 */
export function Interruptor({
  activo,
  onCambiar,
  etiqueta,
  peligroso = false,
  desactivado = false,
}: {
  activo: boolean
  onCambiar: (valor: boolean) => void
  /** Va al lado del interruptor y es también su nombre accesible. */
  etiqueta: string
  peligroso?: boolean
  desactivado?: boolean
}) {
  return (
    <label
      className={`relative inline-flex items-center gap-3 ${
        desactivado ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
      }`}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={activo}
        disabled={desactivado}
        onChange={(e) => onCambiar(e.target.checked)}
      />
      <span
        aria-hidden
        className={`h-7 w-12 shrink-0 rounded-full bg-linea-fuerte transition-colors duration-200 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ensayo ${
          peligroso ? 'peer-checked:bg-vivo' : 'peer-checked:bg-tinta'
        }`}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute top-1 left-1 h-5 w-5 rounded-full bg-lienzo transition-transform duration-200 ease-in-out peer-checked:translate-x-5"
      />
      <span className="text-sm font-medium">{etiqueta}</span>
    </label>
  )
}
