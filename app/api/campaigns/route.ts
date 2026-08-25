import { NextResponse } from 'next/server'
import { asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { DEFAULT_DAILY_LIMIT, MAX_DAILY_LIMIT, campaigns, icps } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'
import { obtenerWorkspace, playbookActivo } from '@/lib/workspace'

export const dynamic = 'force-dynamic'

/** Lo que hay que decidir para crear una campaña. El resto tiene un valor sensato. */
const cuerpo = z.object({
  name: z.string().min(1, 'Ponle un nombre.'),
  /**
   * Instagram salió del producto: el canal sigue existiendo en la base porque
   * el embudo del lead magnet vuelve cuando esté la app de Meta, pero no se
   * puede crear una campaña nueva sobre él.
   */
  channel: z.enum(['linkedin', 'email']),
  accountId: z.string().uuid().nullable().optional(),
  icpId: z.string().uuid().nullable().optional(),
  workspaceId: z.string().uuid().optional(),
  dailyCap: z.number().int().min(1).max(MAX_DAILY_LIMIT).optional(),
})

/**
 * Ventana de envío por defecto: horario de oficina de lunes a viernes.
 *
 * Se puede cambiar después en la campaña. Arranca conservadora porque escribir a
 * un desconocido un domingo a las tres de la mañana es la forma más rápida de
 * que te denuncien la cuenta.
 */
const VENTANA_POR_DEFECTO = {
  tz: 'Europe/Madrid',
  from: '09:00',
  to: '18:00',
  days: [1, 2, 3, 4, 5],
}

export async function GET(request: Request) {
  const workspaceId = new URL(request.url).searchParams.get('workspaceId')

  try {
    const empresa = await obtenerWorkspace(workspaceId)
    const filas = empresa
      ? await db
          .select()
          .from(campaigns)
          .where(eq(campaigns.workspaceId, empresa.id))
          .orderBy(desc(campaigns.createdAt))
      : []
    return NextResponse.json({ campanas: filas, empresa })
  } catch (err) {
    return serverError(err, 'No se pudieron leer las campañas')
  }
}

/**
 * Crea una campaña dentro de una empresa.
 *
 * Nace SIEMPRE en 'draft'. Ponerla en marcha es un acto aparte y consciente: es
 * el momento en que la cola de /api/leads/next deja de estar vacía.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  const d = body.data

  try {
    const empresa = await obtenerWorkspace(d.workspaceId)
    if (!empresa) {
      return jsonError('Todavía no hay ninguna empresa. Créala en /empresa antes.', 409)
    }

    // El playbook se resuelve como en todas partes: el suyo si lo tiene, y si no
    // el global de fábrica. Así una campaña nueva ya sabe vender.
    const playbook = await playbookActivo(empresa.id)
    // El ICP por defecto es el de ESTA empresa. Coger el primero de la tabla le
    // daría a un cliente el perfil de cliente ideal de otro.
    const icpId =
      d.icpId ??
      (
        await db
          .select({ id: icps.id })
          .from(icps)
          .where(eq(icps.workspaceId, empresa.id))
          .orderBy(asc(icps.createdAt))
          .limit(1)
      )[0]?.id ??
      null

    const [creada] = await db
      .insert(campaigns)
      .values({
        name: d.name,
        status: 'draft',
        channel: d.channel,
        accountId: d.accountId ?? null,
        icpId,
        playbookId: playbook?.id ?? null,
        workspaceId: empresa.id,
        dailyCap: d.dailyCap ?? DEFAULT_DAILY_LIMIT,
        sendingWindow: VENTANA_POR_DEFECTO,
        followupDelays: [3, 5, 7],
        maxTouches: 4,
      })
      .returning()

    return NextResponse.json(creada, { status: 201 })
  } catch (err) {
    return serverError(err, traducir(err, d.channel))
  }
}

/**
 * Las dos claves ajenas compuestas dan errores de Postgres ilegibles. Son
 * exactamente los dos fallos que se cometen al configurar una campaña, así que
 * merecen decir qué ha pasado.
 */
export function traducir(err: unknown, canal: string): string {
  const msg = err instanceof Error ? err.message : ''
  if (msg.includes('campaigns_account_channel_fk')) {
    return `Esa cuenta no es de ${canal}. Elige una cuenta del mismo canal.`
  }
  if (msg.includes('campaigns_account_workspace_fk')) {
    return 'Esa cuenta es de otra empresa. Cada cuenta conectada pertenece a una sola.'
  }
  return 'No se pudo crear la campaña'
}
