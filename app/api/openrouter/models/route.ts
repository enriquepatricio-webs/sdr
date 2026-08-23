import { NextResponse } from 'next/server'
import { listModels } from '@/lib/openrouter'
import { serverError } from '@/lib/api'

// El catálogo rota, pero no cada minuto.
export const revalidate = 21600

/** Lista de modelos para el selector. El endpoint de OpenRouter es público. */
export async function GET() {
  try {
    const modelos = await listModels()
    return NextResponse.json({
      // Solo los que sirven para este agente: usa tools y salidas estructuradas.
      modelos: modelos.filter((m) => m.supportsTools && m.supportsStructuredOutputs),
    })
  } catch (err) {
    return serverError(err, 'No se pudo leer el catálogo de OpenRouter')
  }
}
