import { NextResponse } from 'next/server'
import { asc, count, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { accounts, leadMagnets, magnetContacts } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'
import { MENCIONA_DINERO } from '@/lib/sin-precios'
import { obtenerWorkspace, workspaceActivo } from '@/lib/workspace'

export const dynamic = 'force-dynamic'

/** La empresa pedida, y si no la que el usuario tiene seleccionada arriba. */
const empresa = (id?: string | null) => (id ? obtenerWorkspace(id) : workspaceActivo())

/** Lista los imanes del workspace con cuánta gente hay en cada estado. */
export async function GET(request: Request) {
  try {
    const ws = await empresa(new URL(request.url).searchParams.get('workspace_id'))
    if (!ws) return NextResponse.json({ imanes: [] })

    const imanes = await db
      .select({
        iman: leadMagnets,
        cuenta: accounts.displayName,
        contactos: count(magnetContacts.id),
        entregados: sql<number>`count(*) filter (where ${magnetContacts.state} in ('entregado','en_conversacion'))::int`,
      })
      .from(leadMagnets)
      .innerJoin(accounts, eq(leadMagnets.accountId, accounts.id))
      .leftJoin(magnetContacts, eq(magnetContacts.magnetId, leadMagnets.id))
      .where(eq(leadMagnets.workspaceId, ws.id))
      .groupBy(leadMagnets.id, accounts.displayName)
      .orderBy(asc(leadMagnets.createdAt))

    return NextResponse.json({ imanes })
  } catch (err) {
    return serverError(err, 'No se pudieron leer los imanes')
  }
}

/**
 * Los textos que va a recibir una persona no pueden llevar cifras de dinero.
 *
 * Se comprueba al guardar y no solo al enviar: es el único momento en el que
 * quien lo escribió está delante y puede arreglarlo.
 */
const sinDinero = (campo: string) =>
  z.string().min(1).max(2000).refine((t) => !MENCIONA_DINERO.test(t), {
    message: `${campo} menciona dinero. Las cifras se dan en la reunión, no por mensaje.`,
  })

const cuerpo = z.object({
  name: z.string().min(1).max(120),
  accountId: z.string().uuid(),
  postUrl: z.string().url(),
  keyword: z.string().min(1).max(60),
  resource: sinDinero('El recurso'),
  followMessage: sinDinero('El mensaje de seguimiento'),
  pitchMeeting: z.boolean().default(true),
  /**
   * Un imán nace encendido.
   *
   * Nacía apagado y el formulario no tiene casilla para encenderlo, así que
   * todos los imanes creados desde el panel quedaban mudos hasta que alguien
   * encontraba el botón "Activar" de la lista. Se crea un imán para usarlo: si
   * hay que revisarlo antes, el botón de apagar sigue estando.
   *
   * Apagado por defecto solo tiene sentido cuando crear algo ya lo pone a
   * escribir a desconocidos. Un imán no hace nada hasta que alguien comenta la
   * palabra, y quien comenta la palabra está pidiendo que le contesten.
   */
  active: z.boolean().default(true),
  workspaceId: z.string().uuid().optional(),
})

export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  const d = body.data

  try {
    const ws = await empresa(d.workspaceId)
    if (!ws) return jsonError('No hay ninguna empresa dada de alta todavía.', 409)

    const [cuenta] = await db.select().from(accounts).where(eq(accounts.id, d.accountId))
    if (!cuenta) return jsonError('Esa cuenta no existe.', 404)
    if (cuenta.provider !== 'instagram') {
      return jsonError('Un imán solo funciona sobre una cuenta de Instagram.', 409)
    }
    if (cuenta.workspaceId !== ws.id) {
      return jsonError('Esa cuenta es de otra empresa.', 409)
    }
    /**
     * Sin el @usuario real no se puede comprobar quién sigue a esa cuenta, y el
     * imán pediría el follow para no entregar nunca el recurso. Se dice AQUÍ, al
     * crearlo, y no dentro del cron a las tres de la mañana.
     */
    if (!cuenta.instagramUsername?.trim()) {
      return jsonError(
        `Antes hay que decir cuál es el @usuario de Instagram de "${cuenta.displayName}". Se pone en Ajustes → La empresa. Sin él no se puede comprobar quién te sigue y el recurso no se entregaría nunca.`,
        409,
      )
    }

    const [creado] = await db
      .insert(leadMagnets)
      .values({ ...d, workspaceId: ws.id, keyword: d.keyword.trim() })
      .returning()

    return NextResponse.json(creado, { status: 201 })
  } catch (err) {
    return serverError(err, 'No se pudo crear el imán')
  }
}
