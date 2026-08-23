import { NextResponse } from 'next/server'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { icps } from '@/lib/db/schema'
import { parseBody, serverError } from '@/lib/api'
import { construirSystemPrompt } from '@/lib/agent-prompt'
import { ajustesEfectivos } from '@/lib/workspace'
import { OpenRouterError, chat } from '@/lib/openrouter'

export const dynamic = 'force-dynamic'
// El LLM puede tardar; que no lo corte el timeout por defecto de la plataforma.
export const maxDuration = 120

const cuerpo = z.object({
  // Se prueba lo que hay EN PANTALLA, esté guardado o no. Ese es el punto.
  systemPrompt: z.string().min(1),
  offer: z.string(),
  qualificationCriteria: z.array(z.any()).default([]),
  objections: z.array(z.any()).default([]),
  bookingRules: z.any(),
  canal: z.enum(['linkedin', 'email', 'instagram']).default('linkedin'),
  icpId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  /** Lo que diría el prospecto. */
  mensaje: z.string().min(1, 'Escribe lo que diría el prospecto.'),
  /** Turnos previos, para poder ensayar una conversación y no solo un mensaje. */
  historial: z
    .array(z.object({ role: z.enum(['assistant', 'user']), content: z.string() }))
    .default([]),
})

/**
 * El ensayo.
 *
 * Llama a OpenRouter y devuelve la respuesta cruda. NO toca Unipile, NO escribe
 * en `touches`, NO toca ningún lead. Es lo único que hace posible el criterio de
 * aceptación: saber cómo responde el agente a "no me interesa" sin que ningún
 * desconocido reciba nada.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  const d = body.data

  try {
    // Las lecciones y el contexto son los de ESA empresa: si el ensayo usara los
    // globales estarías probando un agente distinto del que escribe de verdad.
    const ajustes = await ajustesEfectivos(d.workspaceId)

    const icp = d.icpId
      ? ((await db.select().from(icps).where(eq(icps.id, d.icpId)))[0] ?? null)
      : ((await db.select().from(icps).orderBy(asc(icps.createdAt)).limit(1))[0] ?? null)

    const vendedora = ajustes.workspace

    const systemPrompt = construirSystemPrompt(
      {
        systemPrompt: d.systemPrompt,
        offer: d.offer,
        qualificationCriteria: d.qualificationCriteria,
        objections: d.objections,
        bookingRules: d.bookingRules,
      },
      icp,
      {
        empresa: ajustes.companyName,
        canal: d.canal,
        vendedora,
        // El ensayo incluye las lecciones: si no, probarías un agente distinto
        // del que escribe de verdad.
        lecciones: ajustes.lessons,
      },
    )

    const resultado = await chat({
      model: ajustes.openrouterModel,
      temperature: 0.7,
      maxTokens: 700,
      messages: [
        { role: 'system', content: systemPrompt },
        ...d.historial.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: d.mensaje },
      ],
    })

    return NextResponse.json({
      respuesta: resultado.text,
      modelo: resultado.model,
      costeUsd: resultado.usage.cost ?? null,
      tokens: {
        entrada: resultado.usage.prompt_tokens,
        salida: resultado.usage.completion_tokens,
      },
      latenciaMs: resultado.latencyMs,
      // Se devuelve el prompt montado: al depurar hay que poder ver el texto exacto.
      systemPrompt,
    })
  } catch (err) {
    if (err instanceof OpenRouterError) {
      return NextResponse.json(
        { error: `OpenRouter falló: ${err.message}`, status: err.status },
        { status: 502 },
      )
    }
    return serverError(err, 'No se pudo ejecutar el ensayo')
  }
}
