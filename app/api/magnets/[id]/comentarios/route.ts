import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, parseBody, serverError } from "@/lib/api";
import { atenderComentarios } from "@/lib/magnets-meta";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Atiende a mano los comentarios de un imán.
 *
 * Con `ensayo: true` no escribe a nadie: devuelve exactamente lo que haría.
 * Existe porque esto manda mensajes a personas reales y, una vez enviados, no
 * hay vuelta atrás: poder verlo antes cuesta un parámetro.
 */
const cuerpo = z.object({
  ensayo: z.boolean().default(true),
  /** Tope por vuelta. Evita que un post con cien comentarios dispare cien DMs. */
  maximo: z.number().int().min(1).max(50).default(10),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await parseBody(request, cuerpo);
  if (!body.ok) return body.response;

  try {
    const r = await atenderComentarios(id, body.data);
    if (r.error) return jsonError(r.error, 409);
    return NextResponse.json(r);
  } catch (err) {
    return serverError(err, "No se pudieron atender los comentarios");
  }
}
