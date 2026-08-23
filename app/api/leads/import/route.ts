import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { campaigns, leads, runLogs } from '@/lib/db/schema'
import { jsonError, parseBody, serverError } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const fila = z.object({
  fullName: z.string().min(1),
  headline: z.string().optional(),
  company: z.string().optional(),
  linkedinUrl: z.string().optional(),
  instagramUsername: z.string().optional(),
  email: z.string().optional(),
  providerId: z.string().optional(),
})

const cuerpo = z.object({
  campaignId: z.string().uuid(),
  filas: z.array(fila).min(1).max(5000),
})

/** Quita lo vacío para que la base vea NULL y no cadena vacía. */
function limpiar(v: string | undefined): string | null {
  const t = v?.trim()
  return t ? t : null
}

export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo)
  if (!body.ok) return body.response
  const { campaignId, filas } = body.data

  try {
    const [campana] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId))
    if (!campana) return jsonError('Esa campaña no existe.', 404)

    const validas: (typeof leads.$inferInsert)[] = []
    const rechazadas: { fila: number; nombre: string; motivo: string }[] = []

    filas.forEach((f, i) => {
      const lead = {
        campaignId,
        fullName: f.fullName.trim(),
        headline: limpiar(f.headline),
        company: limpiar(f.company),
        linkedinUrl: limpiar(f.linkedinUrl),
        instagramUsername: limpiar(f.instagramUsername)?.replace(/^@/, '') ?? null,
        email: limpiar(f.email),
        providerId: limpiar(f.providerId),
        status: 'nuevo' as const,
        raw: { origen: 'csv', fila: i + 2 },
      }

      if (!lead.linkedinUrl && !lead.email && !lead.instagramUsername && !lead.providerId) {
        rechazadas.push({ fila: i + 2, nombre: lead.fullName, motivo: 'sin forma de contactarlo' })
        return
      }

      // El canal de la campaña decide qué identificador sirve. Importar un lead
      // sin usuario de Instagram a una campaña de Instagram crea trabajo que
      // nunca se va a poder ejecutar.
      const necesario =
        campana.channel === 'instagram'
          ? lead.instagramUsername
          : campana.channel === 'email'
            ? lead.email
            : (lead.linkedinUrl ?? lead.providerId)

      if (!necesario) {
        rechazadas.push({
          fila: i + 2,
          nombre: lead.fullName,
          motivo: `esta campaña envía por ${campana.channel} y a este lead le falta ese dato`,
        })
        return
      }

      validas.push(lead)
    })

    let importadas = 0
    // Por lotes: 5.000 filas en un solo INSERT se pasan del límite de parámetros.
    for (let i = 0; i < validas.length; i += 200) {
      const insertadas = await db
        .insert(leads)
        .values(validas.slice(i, i + 200))
        // Los índices únicos normalizados absorben el reimportar el mismo fichero.
        .onConflictDoNothing()
        .returning({ id: leads.id })
      importadas += insertadas.length
    }

    const duplicadas = validas.length - importadas

    await db.insert(runLogs).values({
      workflow: 'dashboard',
      level: 'info',
      message: `Importación CSV a "${campana.name}": ${importadas} nuevos, ${duplicadas} ya estaban, ${rechazadas.length} rechazados`,
      payload: { total: filas.length, importadas, duplicadas, rechazadas: rechazadas.slice(0, 50) },
    })

    return NextResponse.json({
      total: filas.length,
      importadas,
      duplicadas,
      rechazadas,
    })
  } catch (err) {
    return serverError(err, 'No se pudo importar el CSV')
  }
}
