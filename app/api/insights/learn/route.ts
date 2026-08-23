import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { runLogs, workspaces } from '@/lib/db/schema'
import { serverError } from '@/lib/api'
import { destilarLecciones } from '@/lib/insights'
import { getSettings } from '@/lib/settings'
import { obtenerWorkspace } from '@/lib/workspace'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Destila lecciones de los mensajes ya enviados y las guarda.
 *
 * A partir de aquí entran en el prompt del agente DE ESA EMPRESA. Si no hay
 * volumen suficiente, NO escribe nada: prefiero un agente sin lecciones que uno
 * con reglas inventadas a partir de cuatro mensajes.
 *
 * Las lecciones son por empresa porque lo que abre una conversación depende de
 * lo que se vende. Eso hace que cada una necesite su propio volumen antes de
 * aprender nada, y es el precio correcto: mejor callar que aplicar a un cliente
 * lo que funcionó con otro.
 */
export async function POST(request: Request) {
  try {
    const empresa = await obtenerWorkspace(
      new URL(request.url).searchParams.get('workspaceId'),
    )
    if (!empresa) {
      return NextResponse.json({ aprendio: false, motivo: 'sin_empresa' })
    }

    const ajustes = await getSettings()
    const resultado = await destilarLecciones(ajustes.openrouterModel, empresa.id)

    if (!resultado.aprendio) {
      return NextResponse.json({
        aprendio: false,
        motivo: resultado.motivo,
        enviados: resultado.enviados,
        hacenFalta: resultado.hacenFalta,
        explicacion:
          resultado.hacenFalta > 0
            ? `Hacen falta ${resultado.hacenFalta} primeros toques más para que la diferencia entre lo que funciona y lo que no signifique algo.`
            : 'Todos los mensajes cayeron del mismo lado: sin contraste no hay nada que aprender todavía.',
      })
    }

    await db
      .update(workspaces)
      .set({ lessons: resultado.lecciones, updatedAt: new Date() })
      .where(eq(workspaces.id, empresa.id))

    await db.insert(runLogs).values({
      workflow: 'sdr-aprender',
      level: 'info',
      message: `Lecciones de ${empresa.name} actualizadas sobre ${resultado.lecciones.basadoEn} mensajes`,
      payload: { ...resultado.lecciones, coste_usd: resultado.costeUsd },
    })

    return NextResponse.json({ aprendio: true, lecciones: resultado.lecciones, costeUsd: resultado.costeUsd })
  } catch (err) {
    return serverError(err, 'No se pudo aprender de los resultados')
  }
}
