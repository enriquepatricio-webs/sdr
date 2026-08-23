/** Utilidades comunes de los route handlers. */
import { NextResponse } from 'next/server'
import { ZodError, type ZodType, z } from 'zod'

export function jsonError(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status })
}

/**
 * Valida el cuerpo de la petición contra un esquema y devuelve un 400 legible
 * en vez de reventar con un 500 opaco.
 */
export async function parseBody<T>(
  request: Request,
  schema: ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return { ok: false, response: jsonError('El cuerpo no es JSON válido.') }
  }
  try {
    return { ok: true, data: schema.parse(raw) }
  } catch (err) {
    if (err instanceof ZodError) {
      return {
        ok: false,
        response: jsonError('Cuerpo inválido.', 400, {
          detalles: err.issues.map((i) => ({ campo: i.path.join('.'), problema: i.message })),
        }),
      }
    }
    throw err
  }
}

/** Convierte cualquier excepción en un 500 con un mensaje que sirva de algo. */
export function serverError(err: unknown, contexto: string) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[${contexto}]`, err)
  return jsonError(`${contexto}: ${message}`, 500)
}

/**
 * Una fecha ISO 8601, venga en UTC o con desfase horario.
 *
 * `z.string().datetime()` a secas EXIGE que acabe en `Z` y rechaza
 * `2026-08-26T20:53:58+02:00`. El `$now.plus(3,'days').toISO()` de n8n devuelve
 * exactamente eso, con lo que todas las rutas que recibían una fecha desde un
 * workflow contestaban 400 "Invalid ISO datetime". Como los nodos van con
 * `continueRegularOutput`, el fallo no paraba nada: simplemente no se enviaba
 * ni un mensaje y no se enteraba nadie.
 *
 * Está aquí, y no repetido en nueve rutas, porque el que se dejó estricto es el
 * que rompe el sistema entero.
 */
export const fechaIso = () => z.string().datetime({ offset: true })
