import { NextResponse } from 'next/server'
import { z } from 'zod'
import { parseBody, serverError } from '@/lib/api'
import { crearEnlaceDeConexion } from '@/lib/unipile'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const cuerpo = z.object({
  proveedor: z.enum(['LINKEDIN', 'INSTAGRAM', 'GOOGLE', 'MICROSOFT']),
})

/**
 * Devuelve el enlace del asistente de conexión de Unipile.
 *
 * El usuario mete sus credenciales de LinkedIn o Instagram en la pantalla de
 * Unipile, nunca en la nuestra: aquí no se ve ni se guarda esa contraseña. Al
 * volver, /api/accounts/sync trae la cuenta ya conectada.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response

  /**
   * El origen desde el que se está pidiendo, no una variable de entorno.
   *
   * Con NEXT_PUBLIC_APP_URL, si esa variable apunta a otro dominio (un preview,
   * http en vez de https, o con barra final) Unipile te devuelve a un origen
   * donde tu cookie NO EXISTE. No es que no viaje: es que se firmó en otro
   * sitio. Y entonces parece que conectar la cuenta te ha cerrado la sesión.
   *
   * La petición viene por fetch desde el propio dashboard, así que Origin
   * siempre llega y siempre es el host exacto en el que está el usuario.
   */
  const base =
    request.headers.get('origin') ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

  try {
    const { url } = await crearEnlaceDeConexion({
      proveedores: [body.data.proveedor],
      urlExito: `${base}/conectado?ok=1`,
      urlFallo: `${base}/conectado?ok=0`,
      referencia: 'sdr-dashboard',
    })
    return NextResponse.json({ url })
  } catch (err) {
    return serverError(err, 'No se pudo generar el enlace de conexión')
  }
}
