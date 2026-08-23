/**
 * Un workspace es una empresa para la que se vende: su contexto, su web, su
 * oferta y sus cuentas conectadas. Todo lo que el agente dice sale de aquí.
 *
 * La tabla se llama `sellers` en la base de datos por historia; en el código es
 * `workspaces`, que es lo que significa.
 */
import { cookies } from 'next/headers'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from './db'
import { accounts, campaigns, leads, playbooks, workspaces } from './db/schema'
import { DEFAULT_SETTINGS, getSettings, type Settings } from './settings'
import { COOKIE_EMPRESA } from './empresa'

export type Workspace = typeof workspaces.$inferSelect

/**
 * Ajustes que se deciden una vez para todo el sistema, no por empresa.
 *
 * `openrouterModel` y `enrichBeforeContact` son decisiones técnicas, no de
 * ventas. `autoProspectMaxSearchesPerDay` es un freno de gasto: si fuese por
 * workspace, cinco workspaces multiplicarían la factura de Apify por cinco.
 */
export const AJUSTES_GLOBALES = [
  'openrouterModel',
  'enrichBeforeContact',
  'autoProspectMaxSearchesPerDay',
] as const

/** Lo que cada empresa decide por su cuenta. Vive en columnas de `sellers`. */
export const AJUSTES_POR_WORKSPACE = [
  'autopilot',
  'telegramChatId',
  'lessons',
  'autoProspect',
  'autoProspectMinLeads',
  'autoProspectMaxItems',
  'autoProspectMinScore',
] as const

export async function listarWorkspaces(): Promise<Workspace[]> {
  return db.select().from(workspaces).orderBy(asc(workspaces.createdAt))
}

/**
 * El workspace pedido, o el primero si no se pide ninguno.
 *
 * El caso de "ninguno" es el normal: hoy hay una empresa y el usuario no quiere
 * elegirla en cada pantalla. En cuanto haya varias, quien llame pasa el id.
 */
export async function obtenerWorkspace(id?: string | null): Promise<Workspace | null> {
  if (id) {
    const [uno] = await db.select().from(workspaces).where(eq(workspaces.id, id))
    return uno ?? null
  }
  const [primero] = await db.select().from(workspaces).orderBy(asc(workspaces.createdAt)).limit(1)
  return primero ?? null
}

/**
 * La empresa que el usuario está mirando ahora mismo, según la cookie del
 * selector de la cabecera. Con una sola empresa siempre es esa.
 *
 * La cookie no manda: `obtenerWorkspace` la valida contra la lista real y cae en
 * la primera si el id ya no existe.
 */
export async function workspaceActivo(): Promise<Workspace | null> {
  const galleta = await cookies()
  return obtenerWorkspace(galleta.get(COOKIE_EMPRESA)?.value)
}

export async function workspaceDeCampana(campaignId: string): Promise<Workspace | null> {
  const [fila] = await db
    .select({ ws: workspaces })
    .from(campaigns)
    .innerJoin(workspaces, eq(workspaces.id, campaigns.workspaceId))
    .where(eq(campaigns.id, campaignId))
  return fila?.ws ?? null
}

export async function workspaceDeLead(leadId: string): Promise<Workspace | null> {
  const [fila] = await db
    .select({ ws: workspaces })
    .from(leads)
    .innerJoin(campaigns, eq(campaigns.id, leads.campaignId))
    .innerJoin(workspaces, eq(workspaces.id, campaigns.workspaceId))
    .where(eq(leads.id, leadId))
  return fila?.ws ?? null
}

export async function workspaceDeCuenta(accountId: string): Promise<Workspace | null> {
  const [fila] = await db
    .select({ ws: workspaces })
    .from(accounts)
    .innerJoin(workspaces, eq(workspaces.id, accounts.workspaceId))
    .where(eq(accounts.id, accountId))
  return fila?.ws ?? null
}

/**
 * Los ajustes que valen para una empresa concreta: los globales tal cual, los
 * de venta leídos de su fila.
 *
 * El autopiloto es SOLO el del workspace. No se cruza con el global a propósito:
 * dos interruptores para encender lo mismo es exactamente lo que el usuario
 * pidió quitar. El global se queda como respaldo para el código que aún no sabe
 * de qué empresa habla, y el botón de parada apaga los dos (ver `pararTodo`).
 */
export async function ajustesEfectivos(
  workspaceId?: string | null,
): Promise<Settings & { workspace: Workspace | null }> {
  const [globales, ws] = await Promise.all([getSettings(), obtenerWorkspace(workspaceId)])
  if (!ws) return { ...globales, workspace: null }

  return {
    ...globales,
    autopilot: ws.autopilot,
    telegramChatId: ws.telegramChatId || globales.telegramChatId,
    companyName: ws.name,
    lessons: ws.lessons ?? null,
    autoProspect: ws.autoProspect,
    autoProspectMinLeads: ws.autoProspectMinLeads,
    autoProspectMaxItems: ws.autoProspectMaxItems,
    autoProspectMinScore: ws.autoProspectMinScore,
    workspace: ws,
  }
}

/**
 * El playbook que rige para una empresa: el suyo propio si lo tiene, y si no el
 * global, que es el que trae el sistema de fábrica.
 *
 * Que el global exista es lo que permite no preguntar nada sobre método de
 * venta al dar de alta una empresa.
 */
export async function playbookActivo(workspaceId?: string | null) {
  if (workspaceId) {
    const [propio] = await db
      .select()
      .from(playbooks)
      .where(and(eq(playbooks.workspaceId, workspaceId), eq(playbooks.isActive, true)))
    if (propio) return propio
  }
  const [global] = await db
    .select()
    .from(playbooks)
    .where(and(isNull(playbooks.workspaceId), eq(playbooks.isActive, true)))
  return global ?? null
}

/**
 * Parada de emergencia. Apaga el autopiloto de todas las empresas y el global.
 *
 * Apagar solo el global dejaría cada workspace creyendo que sigue encendido,
 * que es el fallo que tenía antes de haber workspaces.
 */
export async function pararTodo(): Promise<{ workspaces: number }> {
  const filas = await db
    .update(workspaces)
    .set({ autopilot: false, autoProspect: false, updatedAt: new Date() })
    .returning({ id: workspaces.id })
  return { workspaces: filas.length }
}

export const AUTOPILOTO_POR_DEFECTO = DEFAULT_SETTINGS.autopilot
