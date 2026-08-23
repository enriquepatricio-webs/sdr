import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { runLogs, workspaces } from '@/lib/db/schema'
import { parseBody, serverError } from '@/lib/api'
import { setSetting } from '@/lib/settings'
import { ajustesEfectivos, obtenerWorkspace } from '@/lib/workspace'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const workspaceId = new URL(request.url).searchParams.get('workspaceId')

  try {
    return NextResponse.json(await ajustesEfectivos(workspaceId))
  } catch (err) {
    return serverError(err, 'No se pudieron leer los ajustes')
  }
}

/**
 * Tiene que aceptar TODO lo que manda la pantalla de ajustes.
 *
 * Antes solo listaba cuatro campos, y zod descarta las claves desconocidas sin
 * quejarse: el endpoint devolvía 200, la interfaz escribía "Guardado." y no se
 * guardaba nada. Un fallo silencioso perfecto, y muy caro de depurar.
 *
 * `.strict()` es lo que impide que vuelva a pasar: una clave que no esté aquí
 * ahora da un 400 explícito en vez de desaparecer.
 */
const cuerpo = z
  .object({
    workspaceId: z.string().uuid().optional(),
    autopilot: z.boolean().optional(),
    openrouterModel: z.string().min(1).optional(),
    telegramChatId: z.string().optional(),
    companyName: z.string().min(1).optional(),
    enrichBeforeContact: z.boolean().optional(),
    autoProspect: z.boolean().optional(),
    autoProspectMinLeads: z.number().int().min(1).max(1000).optional(),
    autoProspectMaxSearchesPerDay: z.number().int().min(1).max(50).optional(),
    autoProspectMaxItems: z.number().int().min(1).max(500).optional(),
    autoProspectMinScore: z.number().int().min(0).max(100).optional(),
  })
  .strict()

/**
 * Qué campo vive en la fila de la empresa y con qué nombre de columna.
 *
 * Lo que no esté aquí va a la tabla `settings`, que es global. La lista es
 * explícita a propósito: si alguien añade un ajuste nuevo tiene que decidir de
 * forma consciente si es de una empresa o de todo el sistema.
 */
const COLUMNA_DE_WORKSPACE = {
  autopilot: 'autopilot',
  telegramChatId: 'telegramChatId',
  companyName: 'name',
  autoProspect: 'autoProspect',
  autoProspectMinLeads: 'autoProspectMinLeads',
  autoProspectMaxItems: 'autoProspectMaxItems',
  autoProspectMinScore: 'autoProspectMinScore',
} as const

type CampoDeWorkspace = keyof typeof COLUMNA_DE_WORKSPACE

export async function PATCH(request: Request) {
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response

  const { workspaceId, ...campos } = body.data

  try {
    const ws = await obtenerWorkspace(workspaceId)

    const deLaEmpresa: Record<string, unknown> = {}
    for (const [clave, valor] of Object.entries(campos)) {
      if (valor === undefined) continue
      if (clave in COLUMNA_DE_WORKSPACE) {
        deLaEmpresa[COLUMNA_DE_WORKSPACE[clave as CampoDeWorkspace]] = valor
      } else {
        await setSetting(clave as 'openrouterModel', valor as never)
      }
    }

    if (Object.keys(deLaEmpresa).length) {
      // Sin empresa dada de alta no hay dónde guardar esto. Antes caía en la
      // tabla global y parecía guardado; ahora se dice.
      if (!ws) {
        return NextResponse.json(
          { error: 'Todavía no hay ninguna empresa. Créala en /empresa antes de ajustar esto.' },
          { status: 409 },
        )
      }
      await db
        .update(workspaces)
        .set({ ...deLaEmpresa, updatedAt: new Date() })
        .where(eq(workspaces.id, ws.id))
    }

    // Encender el autopiloto es el cambio con consecuencias del sistema: a
    // partir de ahí los mensajes salen solos. Queda registrado siempre.
    if (campos.autopilot !== undefined) {
      await db.insert(runLogs).values({
        workflow: 'dashboard',
        level: campos.autopilot ? 'warn' : 'info',
        message: `Autopiloto ${campos.autopilot ? 'ENCENDIDO: los mensajes salen solos' : 'apagado'}${ws ? ` en ${ws.name}` : ''}`,
      })
    }

    return NextResponse.json(await ajustesEfectivos(ws?.id))
  } catch (err) {
    return serverError(err, 'No se pudieron guardar los ajustes')
  }
}
