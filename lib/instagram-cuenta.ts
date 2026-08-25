import { eq } from "drizzle-orm";
import { db } from "./db";
import { accounts, runLogs } from "./db/schema";
import { DIAS_PARA_RENOVAR, renovarToken } from "./instagram";

export type CuentaInstagram = {
  id: string;
  token: string;
  igUserId: string;
  username: string | null;
};

/**
 * El token de una cuenta, siempre válido.
 *
 * Renueva solo si le quedan menos de diez días, y lo hace AQUÍ y no en un cron
 * a propósito: un cron es una cosa más que puede pararse sin que nadie se
 * entere, y descubrirlo son sesenta días después con el imán mudo. Renovar en
 * el momento de usarlo hace que la conexión se mantenga viva exactamente
 * mientras se esté usando, que es cuando importa.
 *
 * Si la renovación falla se sigue con el token viejo: todavía sirve, y romper
 * el envío por no haber podido renovar sería cambiar un problema de dentro de
 * diez días por uno de ahora mismo.
 */
/**
 * Da la cuenta por desautorizada.
 *
 * Se borra el token en vez de marcar una bandera: así el panel enseña "sin
 * autorizar" y su botón, que es exactamente lo que hay que hacer. Una cuenta
 * con un token muerto y fecha de caducidad futura se pinta como sana mientras
 * nada funciona.
 */
export async function desautorizar(
  accountId: string,
  motivo: string,
): Promise<void> {
  await db
    .update(accounts)
    .set({ metaToken: null, metaTokenExpiresAt: null })
    .where(eq(accounts.id, accountId));
  await db.insert(runLogs).values({
    workflow: "instagram",
    level: "error",
    message: `Instagram invalidó la sesión de la cuenta: hay que volver a autorizarla. ${motivo}`,
    payload: { accountId },
  });
}

export async function tokenDeCuenta(
  accountId: string,
): Promise<CuentaInstagram | null> {
  const [cuenta] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!cuenta?.metaToken || !cuenta.igUserId) return null;

  const quedan = cuenta.metaTokenExpiresAt
    ? (cuenta.metaTokenExpiresAt.getTime() - Date.now()) / 86_400_000
    : 0;

  let token = cuenta.metaToken;
  if (quedan < DIAS_PARA_RENOVAR) {
    try {
      const nuevo = await renovarToken(token);
      token = nuevo.access_token;
      await db
        .update(accounts)
        .set({
          metaToken: token,
          metaTokenExpiresAt: new Date(Date.now() + nuevo.expires_in * 1000),
        })
        .where(eq(accounts.id, cuenta.id));
    } catch (err) {
      await db.insert(runLogs).values({
        workflow: "instagram",
        level: "warn",
        message: `No se pudo renovar el token de ${cuenta.displayName}, se sigue con el actual: ${
          err instanceof Error ? err.message : String(err)
        }`,
        payload: { accountId: cuenta.id, diasRestantes: Math.round(quedan) },
      });
    }
  }

  return {
    id: cuenta.id,
    token,
    igUserId: cuenta.igUserId,
    username: cuenta.instagramUsername,
  };
}
