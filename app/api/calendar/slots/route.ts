import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { leads, playbooks, runLogs } from "@/lib/db/schema";
import { jsonError, parseBody, serverError } from "@/lib/api";
import { consultarDisponibilidad, describirHueco } from "@/lib/composio";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const cuerpo = z.object({
  leadId: z.string().uuid().optional(),
  /** Preferencia que ha dado el prospecto en el cierre en embudo. */
  preferencia: z.enum(["manana", "tarde", "cualquiera"]).default("cualquiera"),
  /** Día concreto que ha pedido, en YYYY-MM-DD. */
  dia: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * Huecos reales de la agenda, ya filtrados por las reglas del playbook.
 *
 * Existe para que el agente NUNCA hable con Composio directamente. Aquí se
 * aplican duración, antelación mínima, colchón, horario y reparto, y se devuelve
 * una lista corta y ya redactada.
 *
 * Si el calendario falla, devuelve 503 con `escala: true`. El agente tiene
 * instrucciones de decirle al prospecto que le confirma en un rato y escalar,
 * nunca de inventarse un hueco.
 */
export async function POST(request: Request) {
  const body = await parseBody(request, cuerpo);
  if (!body.ok) return body.response;
  const d = body.data;

  try {
    const [playbook] = await db
      .select()
      .from(playbooks)
      .where(eq(playbooks.isActive, true));
    if (!playbook) return jsonError("No hay playbook activo.", 409);
    const reglas = playbook.bookingRules;

    let huecos;
    try {
      huecos = await consultarDisponibilidad(reglas);
    } catch (err) {
      // Se registra SIEMPRE, con lead o sin él. Antes solo con leadId, así que
      // una comprobación suelta —la forma natural de probar si la agenda va—
      // devolvía "no se ha podido" sin dejar en ninguna parte el porqué.
      await db.insert(runLogs).values({
        workflow: "sdr-inbound",
        leadId: d.leadId ?? null,
        level: "error",
        message: `El calendario no responde: ${err instanceof Error ? err.message : String(err)}`,
      });
      return NextResponse.json(
        {
          error: "No se ha podido consultar el calendario.",
          escala: true,
          // Se le da al agente lo que debe decir, para que no improvise.
          queDecir:
            "Dile que le confirmas el hueco en un rato y llama a escalar_humano. No propongas ninguna franja.",
        },
        { status: 503 },
      );
    }

    // Filtro por lo que el prospecto ha pedido en el embudo.
    const filtrados = huecos.filter((h) => {
      if (d.dia && !h.inicio.toISOString().startsWith(d.dia)) return false;
      if (d.preferencia === "cualquiera") return true;
      const hora = Number(
        new Intl.DateTimeFormat("en-CA", {
          timeZone: reglas.timezone,
          hour: "2-digit",
          hourCycle: "h23",
        }).format(h.inicio),
      );
      return d.preferencia === "manana" ? hora < 14 : hora >= 14;
    });

    // Si su preferencia no deja nada, se devuelve lo que hay: mejor ofrecer algo
    // real fuera de su franja que no ofrecer nada.
    const finales = (filtrados.length ? filtrados : huecos).slice(
      0,
      reglas.max_slots_offered,
    );

    return NextResponse.json({
      huecos: finales.map((h) => ({
        inicio: h.inicio.toISOString(),
        fin: h.fin.toISOString(),
        texto: describirHueco(h, reglas.timezone),
      })),
      timezone: reglas.timezone,
      duracionMin: reglas.duration_min,
      seAjustoALaPreferencia: filtrados.length > 0,
    });
  } catch (err) {
    return serverError(err, "No se pudieron consultar los huecos");
  }
}
