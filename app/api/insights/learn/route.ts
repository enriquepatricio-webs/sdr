import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { runLogs } from '@/lib/db/schema'
import { serverError } from '@/lib/api'
import { destilarLecciones } from '@/lib/insights'
import { getSettings, setSetting } from '@/lib/settings'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Destila lecciones de los mensajes ya enviados y las guarda.
 *
 * A partir de aquí entran en el prompt de todos los agentes. Si no hay volumen
 * suficiente, NO escribe nada: prefiero un agente sin lecciones que uno con
 * reglas inventadas a partir de cuatro mensajes.
 */
export async function POST() {
  try {
    const ajustes = await getSettings()
    const resultado = await destilarLecciones(ajustes.openrouterModel)

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

    await setSetting('lessons', resultado.lecciones)

    await db.insert(runLogs).values({
      workflow: 'sdr-aprender',
      level: 'info',
      message: `Lecciones actualizadas sobre ${resultado.lecciones.basadoEn} mensajes`,
      payload: { ...resultado.lecciones, coste_usd: resultado.costeUsd },
    })

    return NextResponse.json({ aprendio: true, lecciones: resultado.lecciones, costeUsd: resultado.costeUsd })
  } catch (err) {
    return serverError(err, 'No se pudo aprender de los resultados')
  }
}
