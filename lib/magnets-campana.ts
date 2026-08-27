import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { campaigns, playbooks, type leadMagnets } from "./db/schema";
import { playbookActivo } from "./workspace";

/**
 * El nombre es el enganche entre el script que lo crea y el código que lo usa.
 * Vive aquí, en una constante, para que renombrarlo rompa la compilación en vez
 * de dejar campañas nuevas con el playbook equivocado y en silencio.
 */
export const NOMBRE_PLAYBOOK_IMAN = "Conversación de lead magnet";

/**
 * La campaña de un imán, creándola la primera vez.
 *
 * Los contactos del imán acaban siendo leads, y un lead necesita una campaña de
 * la que colgar. Vive aparte de `lib/magnets.ts` para que ese fichero siga
 * siendo puro: es lo que permite probar el embudo entero sin base de datos.
 */
/** El playbook de la conversación posterior a entregar un imán, si existe. */
async function playbookDelIman() {
  const [p] = await db
    .select({ id: playbooks.id })
    .from(playbooks)
    .where(eq(playbooks.name, NOMBRE_PLAYBOOK_IMAN));
  return p ?? null;
}

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
      /**
       * Con playbook, que es lo que la hace ejecutable.
       *
       * La base de datos no deja que una campaña esté en marcha sin él, y con
       * razón: sin playbook el agente no sabe qué vende ni cómo agendar, y
       * descubrirlo a mitad de una conversación es descubrirlo tarde. Se coge
       * el de la empresa, o el de fábrica si no tiene uno propio.
       */
      /**
       * El playbook de la conversación de imán, no el de venta en frío.
       *
       * No se parecen en nada: al de la campaña fría hay que convencerlo de que
       * te escuche, y este ya ha levantado la mano y tiene algo tuyo en las
       * manos. Con el playbook frío, el agente le escribía como a un
       * desconocido a alguien que acababa de pedirle el recurso.
       *
       * Si ese playbook no existe todavía —`npm run playbook:iman` lo crea— se
       * usa el activo de la empresa, que es peor pero funciona.
       */
      playbookId:
        (await playbookDelIman())?.id ??
        (await playbookActivo(iman.workspaceId))?.id ??
        null,
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

/**
 * La campaña por la que se contesta a alguien que escribe a una cuenta y ya era
 * un lead nuestro, pero de otra parte.
 *
 * Pasa de verdad: a un prospecto se le escribió en frío desde una cuenta, y
 * meses después contesta a OTRA —la que ve en un anuncio, o la que le sale al
 * buscar la marca—. Su lead sigue colgando de la campaña vieja, cuya cuenta
 * puede estar pausada o ni siquiera autorizada en Meta, y entonces la respuesta
 * no puede salir por ningún sitio.
 *
 * La conversación pertenece a la cuenta donde está ocurriendo, no a la que
 * empezó. Se mueve el lead aquí y se le contesta desde donde escribió.
 */
export async function campanaDeConversaciones(opciones: {
  cuentaId: string;
  workspaceId: string;
  usuario: string;
}): Promise<string> {
  const nombre = `Conversaciones · @${opciones.usuario}`;
  const [existente] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.workspaceId, opciones.workspaceId),
        eq(campaigns.name, nombre),
      ),
    );
  if (existente) return existente.id;

  const [nueva] = await db
    .insert(campaigns)
    .values({
      name: nombre,
      // En marcha: aquí no se prospecta a nadie, solo se responde a quien ya ha
      // escrito. Pausarla sería dejar de contestar, que no es lo mismo que
      // dejar de buscar.
      status: "running",
      playbookId: (await playbookActivo(opciones.workspaceId))?.id ?? null,
      workspaceId: opciones.workspaceId,
      accountId: opciones.cuentaId,
      channel: "instagram",
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
