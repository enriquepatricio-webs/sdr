import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { campaigns, leads, meetings, runLogs } from "@/lib/db/schema";
import { jsonError, parseBody, serverError } from "@/lib/api";
import { obtenerWorkspace } from "@/lib/workspace";
import { fechaIso } from '@/lib/api'

export const dynamic = "force-dynamic";

const cuerpo = z.object({
  leadId: z.string().uuid(),
  composioEventId: z.string().optional(),
  startAt: fechaIso(),
  endAt: fechaIso(),
  meetUrl: z.string().url().optional(),
});

export async function GET(request: Request) {
  try {
    const empresa = await obtenerWorkspace(
      new URL(request.url).searchParams.get("workspaceId"),
    );
    const filas = await db
      .select({ reunion: meetings, lead: leads })
      .from(meetings)
      .innerJoin(leads, eq(meetings.leadId, leads.id))
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(empresa ? eq(campaigns.workspaceId, empresa.id) : undefined)
      .orderBy(desc(meetings.startAt))
      .limit(200);
    return NextResponse.json({ reuniones: filas });
  } catch (err) {
    return serverError(err, "No se pudieron leer las reuniones");
  }
}

/**
 * Registra una reunión agendada y pasa el lead a 'agendado'.
 *
 * Idempotente por composio_event_id: si el workflow reintenta después de haber
 * creado el evento, no aparecen dos reuniones para la misma cita.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo);
  if (!body.ok) return body.response;
  const d = body.data;

  if (new Date(d.endAt) <= new Date(d.startAt)) {
    return jsonError("La reunión no puede terminar antes de empezar.");
  }

  try {
    const [lead] = await db.select().from(leads).where(eq(leads.id, d.leadId));
    if (!lead) return jsonError("Ese lead no existe.", 404);

    const [creada] = await db
      .insert(meetings)
      .values({
        leadId: d.leadId,
        composioEventId: d.composioEventId,
        startAt: new Date(d.startAt),
        endAt: new Date(d.endAt),
        meetUrl: d.meetUrl,
        status: "booked",
      })
      .onConflictDoNothing()
      .returning();

    if (!creada && d.composioEventId) {
      const [existente] = await db
        .select()
        .from(meetings)
        .where(eq(meetings.composioEventId, d.composioEventId));
      return NextResponse.json({ reunion: existente, duplicada: true });
    }

    await db
      .update(leads)
      .set({ status: "agendado", nextActionAt: null })
      .where(eq(leads.id, d.leadId));

    await db.insert(runLogs).values({
      workflow: "sdr-inbound",
      leadId: d.leadId,
      level: "info",
      message: `Reunión agendada para ${d.startAt}`,
      payload: { meetUrl: d.meetUrl, composioEventId: d.composioEventId },
    });

    return NextResponse.json({ reunion: creada, duplicada: false, lead });
  } catch (err) {
    return serverError(err, "No se pudo registrar la reunión");
  }
}
