import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { leadMagnets } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'
import { MENCIONA_DINERO } from '@/lib/sin-precios'

export const dynamic = 'force-dynamic'

const sinDinero = (campo: string) =>
  z.string().min(1).max(2000).refine((t) => !MENCIONA_DINERO.test(t), {
    message: `${campo} menciona dinero. Las cifras se dan en la reunión, no por mensaje.`,
  })

/** Todo opcional: la pantalla lo usa tanto para editar como para el interruptor. */
const cuerpo = z.object({
  name: z.string().min(1).max(120).optional(),
  postUrl: z.string().url().optional(),
  keyword: z.string().min(1).max(60).optional(),
  resource: sinDinero('El recurso').optional(),
  followMessage: sinDinero('El mensaje de seguimiento').optional(),
  pitchMeeting: z.boolean().optional(),
  active: z.boolean().optional(),
})

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  if (!Object.keys(body.data).length) return jsonError('No hay nada que cambiar.')

  try {
    const [actualizado] = await db
      .update(leadMagnets)
      .set(body.data)
      .where(eq(leadMagnets.id, id))
      .returning()
    if (!actualizado) return jsonError('Ese imán no existe.', 404)
    return NextResponse.json(actualizado)
  } catch (err) {
    return serverError(err, 'No se pudo guardar el imán')
  }
}

/**
 * Borra el imán y con él sus contactos (cascada).
 *
 * Los leads y los toques NO se van: son el registro de lo que se le mandó a una
 * persona real y eso no se borra porque se apague una campaña de captación.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const borrados = await db
      .delete(leadMagnets)
      .where(eq(leadMagnets.id, id))
      .returning({ id: leadMagnets.id })
    if (!borrados.length) return jsonError('Ese imán no existe.', 404)
    return NextResponse.json({ borrado: id })
  } catch (err) {
    return serverError(err, 'No se pudo borrar el imán')
  }
}
