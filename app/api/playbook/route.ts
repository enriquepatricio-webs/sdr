import { NextResponse } from "next/server";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { playbooks } from "@/lib/db/schema";
import { parseBody, serverError } from "@/lib/api";
import { activarPlaybook } from "@/lib/playbook";
import { obtenerWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Historial completo, sin los textos largos: esto llena una lista, no un editor. */
export async function GET(request: Request) {
  try {
    // Las versiones de ESTA empresa más el global de fábrica, que también es
    // suyo mientras no lo bifurque.
    const empresa = await obtenerWorkspace(
      new URL(request.url).searchParams.get("workspaceId"),
    );
    const versiones = await db
      .select({
        id: playbooks.id,
        name: playbooks.name,
        version: playbooks.version,
        isActive: playbooks.isActive,
        workspaceId: playbooks.workspaceId,
        createdAt: playbooks.createdAt,
      })
      .from(playbooks)
      .where(
        empresa
          ? or(
              isNull(playbooks.workspaceId),
              eq(playbooks.workspaceId, empresa.id),
            )
          : isNull(playbooks.workspaceId),
      )
      .orderBy(desc(playbooks.createdAt));
    return NextResponse.json({ versiones });
  } catch (err) {
    return serverError(err, "No se pudo leer el historial de playbooks");
  }
}

const criterio = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  weight: z.number().int().min(0).max(100),
  inferable_from: z.string().optional(),
});

const objecion = z.object({
  objection: z.string().min(1),
  response: z.string().min(1),
});

const reglas = z.object({
  duration_min: z.number().int().positive(),
  min_notice_hours: z.number().int().min(0),
  buffer_min: z.number().int().min(0),
  lookahead_days: z.number().int().positive(),
  timezone: z.string().min(1),
  working_hours: z.object({
    from: z.string().regex(/^\d{2}:\d{2}$/),
    to: z.string().regex(/^\d{2}:\d{2}$/),
    days: z.array(z.number().int().min(1).max(7)).min(1),
  }),
  min_score_to_book: z.number().int().min(0).max(100),
  max_slots_offered: z.number().int().positive().max(5),
});

const cuerpoNuevaVersion = z.object({
  name: z.string().min(1),
  systemPrompt: z.string().min(1, "El prompt de sistema no puede estar vacío."),
  offer: z.string().min(1, "La oferta no puede estar vacía."),
  qualificationCriteria: z.array(criterio),
  objections: z.array(objecion),
  bookingRules: reglas,
  /** Por defecto se guarda y se activa: es lo que uno espera al pulsar Guardar. */
  activar: z.boolean().default(true),
  /** De qué empresa es esta versión. Sin esto, todas escriben sobre la global. */
  workspaceId: z.string().uuid().optional(),
});

/**
 * Guardar NUNCA sobrescribe: crea una versión nueva.
 *
 * El playbook es lo que el agente le dice a personas reales. Poder volver a la
 * versión de ayer cuando la de hoy resulta ser peor no es una comodidad.
 *
 * Y la versión nueva pertenece a la EMPRESA desde la que se guarda. Retocar el
 * playbook para un cliente bifurca una copia suya; el global de fábrica se
 * queda intacto y lo siguen usando las demás empresas. Antes toda versión
 * nacía global, así que ajustar el tono para el cliente B se lo cambiaba al A
 * sin que nadie lo pidiera ni se enterase.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, cuerpoNuevaVersion);
  if (!body.ok) return body.response;
  const { activar, workspaceId, ...datos } = body.data;

  try {
    const empresa = await obtenerWorkspace(workspaceId);
    const ambito = empresa
      ? eq(playbooks.workspaceId, empresa.id)
      : isNull(playbooks.workspaceId);

    // La numeración es por empresa: dos clientes con un playbook del mismo
    // nombre no comparten contador de versiones.
    const [{ maxima } = { maxima: 0 }] = await db
      .select({ maxima: sql<number>`coalesce(max(${playbooks.version}), 0)` })
      .from(playbooks)
      .where(and(eq(playbooks.name, datos.name), ambito));

    const [creada] = await db
      .insert(playbooks)
      .values({
        ...datos,
        workspaceId: empresa?.id ?? null,
        version: Number(maxima) + 1,
        isActive: false,
      })
      .returning({ id: playbooks.id, version: playbooks.version });

    if (activar) await activarPlaybook(creada.id);

    return NextResponse.json({
      id: creada.id,
      version: creada.version,
      activa: activar,
    });
  } catch (err) {
    return serverError(err, "No se pudo guardar la versión");
  }
}
