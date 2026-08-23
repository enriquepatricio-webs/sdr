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

const cuerpo = z.object({
  autopilot: z.boolean().optional(),
  openrouterModel: z.string().min(1).optional(),
  telegramChatId: z.string().optional(),
  companyName: z.string().min(1).optional(),
})

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
