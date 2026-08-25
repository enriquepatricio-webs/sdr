import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { campaigns, type leadMagnets } from "./db/schema";

/**
 * La campaña de un imán, creándola la primera vez.
 *
 * Los contactos del imán acaban siendo leads, y un lead necesita una campaña de
 * la que colgar. Vive aparte de `lib/magnets.ts` para que ese fichero siga
 * siendo puro: es lo que permite probar el embudo entero sin base de datos.
 */
export async function campanaDelImanId(
  iman: typeof leadMagnets.$inferSelect,
): Promise<string> {
  const nombre = `Imán: ${iman.name}`;
  const [existente] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.workspaceId, iman.workspaceId),
        eq(campaigns.name, nombre),
      ),
    );
  if (existente) return existente.id;

  const [nueva] = await db
    .insert(campaigns)
    .values({
      name: nombre,
      /**
       * En marcha desde el primer momento, no en borrador.
       *
       * Una campaña en frío nace en borrador porque alguien tiene que revisarla
       * antes de escribir a desconocidos. Esta es lo contrario: solo entran
       * personas que acaban de pedirnos algo por privado y ya tienen el
       * recurso. Lo único que la campaña habilita es seguir la conversación.
       *
       * En borrador, la cola de trabajo la descartaba por "campaña pausada" y
       * el "¿qué tal?" que se programa al entregar no salía nunca: el recurso
       * se mandaba y ahí se acababa todo.
       */
      status: "running",
      workspaceId: iman.workspaceId,
      accountId: iman.accountId,
      channel: "instagram",
      // Un imán responde a quien acaba de escribir: la ventana amplia es
      // deliberada, hacer esperar a mañana rompe la única promesa del embudo.
      sendingWindow: {
        tz: "Europe/Madrid",
        from: "09:00",
        to: "21:00",
        days: [1, 2, 3, 4, 5, 6, 7],
      },
    })
    .returning({ id: campaigns.id });
  return nueva.id;
}
