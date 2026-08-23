import { NextResponse } from 'next/server'
import { serverError } from '@/lib/api'
import { MINIMO_PARA_APRENDER, calcularResultados, obtenerMuestras } from '@/lib/insights'
import { ajustesEfectivos } from '@/lib/workspace'

export const dynamic = 'force-dynamic'

/** Resultados reales y lo que se ha aprendido de ellos. */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const dias = Number(url.searchParams.get('dias')) || 30
  const workspaceId = url.searchParams.get('workspaceId')
  try {
    const desde = new Date(Date.now() - dias * 24 * 3600_000)
    const ajustes = await ajustesEfectivos(workspaceId)
    // Las muestras se cuentan de esta empresa: es sobre las suyas sobre las que
    // podrá aprender, y decirle que ya tiene volumen contando las de otra sería
    // mentirle.
    const [resultados, muestras] = await Promise.all([
      calcularResultados(desde),
      obtenerMuestras(200, ajustes.workspace?.id),
    ])

    return NextResponse.json({
      dias,
      resultados,
      lecciones: ajustes.lessons,
      muestrasDisponibles: muestras.length,
      minimoParaAprender: MINIMO_PARA_APRENDER,
      puedeAprender: muestras.length >= MINIMO_PARA_APRENDER,
    })
  } catch (err) {
    return serverError(err, 'No se pudieron calcular los resultados')
  }
}
