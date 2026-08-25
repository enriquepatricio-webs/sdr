import { NextResponse } from "next/server";
import { z } from "zod";
import { parseBody, serverError } from "@/lib/api";
import { atenderMensaje } from "@/lib/magnets-meta";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Simula que una persona ha contestado al imán.
 *
 * Sirve para probar la comprobación del follow y la entrega sin depender de que
 * el webhook de Meta esté entregando: son dos cosas distintas y mezclarlas hace
 * que un fallo en una parezca un fallo en la otra.
 */
const cuerpo = z.object({ igsid: z.string().min(1), texto: z.string().min(1) });

export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo);
  if (!body.ok) return body.response;
  try {
    return NextResponse.json(
      await atenderMensaje(body.data.igsid, body.data.texto),
    );
  } catch (err) {
    return serverError(err, "No se pudo atender el mensaje");
  }
}
