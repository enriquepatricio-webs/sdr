import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { runLogs, sellers } from '@/lib/db/schema'
import { jsonError, serverError } from '@/lib/api'
import { leerWeb } from '@/lib/scrape'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Lee la web de la empresa vendedora y guarda el texto como contexto.
 *
 * Se guarda aparte de `context` (lo que escribe el usuario) para que se puedan
 * distinguir en el prompt: si se contradicen, manda lo que puso la persona.
 * Mezclarlos haría imposible corregir algo que la web dice mal.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const [empresa] = await db.select().from(sellers).where(eq(sellers.id, id))
    if (!empresa) return jsonError('Esa empresa no existe.', 404)
    if (!empresa.website) return jsonError('Esta empresa no tiene web configurada.', 400)

    const web = await leerWeb(empresa.website, { maxPaginas: 6, maxCaracteres: 8000 })
    if (!web) {
      await db.insert(runLogs).values({
        workflow: 'dashboard',
        level: 'warn',
        message: `No se pudo leer ${empresa.website}`,
      })
      return jsonError(
        `No se pudo leer ${empresa.website}. Comprueba la URL, o escribe el contexto a mano.`,
        502,
      )
    }

    const [actualizada] = await db
      .update(sellers)
      .set({ scrapedContext: web.texto, scrapedAt: new Date() })
      .where(eq(sellers.id, id))
      .returning()

    return NextResponse.json({
      ok: true,
      caracteres: web.texto.length,
      titulo: web.titulo,
      scrapedAt: actualizada.scrapedAt,
    })
  } catch (err) {
    return serverError(err, 'No se pudo leer la web')
  }
}
