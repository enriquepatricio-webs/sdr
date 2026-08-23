import { NextResponse } from 'next/server'
import { serverError } from '@/lib/api'
import { MINIMO_PARA_APRENDER, calcularResultados, obtenerMuestras } from '@/lib/insights'
import { getSettings } from '@/lib/settings'

export const dynamic = 'force-dynamic'

/** Resultados reales y lo que se ha aprendido de ellos. */
export async function GET(request: Request) {
  const dias = Number(new URL(request.url).searchParams.get('dias')) || 30
  try {
    const desde = new Date(Date.now() - dias * 24 * 3600_000)
    const [resultados, muestras, ajustes] = await Promise.all([
      calcularResultados(desde),
      obtenerMuestras(),
      getSettings(),
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
