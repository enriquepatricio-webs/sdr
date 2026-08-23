import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { runLogs } from '@/lib/db/schema'
import { parseBody, serverError } from '@/lib/api'
import { getSettings, setSetting } from '@/lib/settings'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json(await getSettings())
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

export async function PATCH(request: Request) {
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response

  try {
    for (const [clave, valor] of Object.entries(body.data)) {
      if (valor === undefined) continue
      await setSetting(clave as keyof typeof body.data, valor as never)
    }

    // Encender el autopiloto es el cambio con consecuencias del sistema: a
    // partir de ahí los mensajes salen solos. Queda registrado siempre.
    if (body.data.autopilot !== undefined) {
      await db.insert(runLogs).values({
        workflow: 'dashboard',
        level: body.data.autopilot ? 'warn' : 'info',
        message: `Autopiloto ${body.data.autopilot ? 'ENCENDIDO: los mensajes salen solos' : 'apagado'}`,
      })
    }

    return NextResponse.json(await getSettings())
  } catch (err) {
    return serverError(err, 'No se pudieron guardar los ajustes')
  }
}
