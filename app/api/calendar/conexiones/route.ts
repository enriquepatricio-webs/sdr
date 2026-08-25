import { NextResponse } from "next/server";
import { serverError } from "@/lib/api";
import { listarConexiones } from "@/lib/composio";

export const dynamic = "force-dynamic";

/**
 * Qué cuentas hay conectadas en Composio y cuál sirve para el calendario.
 *
 * Existe porque Composio no adivina: con una sola cuenta conectada resolvía
 * solo, pero en cuanto hay más de una responde 400 pidiendo un `user_id` para
 * saber a cuál se refiere. Esta ruta es la que permite verlo y elegir sin tener
 * que sacar la clave de Composio de producción, que es sensible y no se puede
 * volver a leer.
 */
export async function GET() {
  try {
    return NextResponse.json({ conexiones: await listarConexiones() });
  } catch (err) {
    return serverError(err, "No se pudieron leer las conexiones de Composio");
  }
}
