/**
 * Avisos por Telegram.
 *
 * Un aviso que falla nunca debe tumbar la acción que lo provocó: si la reunión
 * está agendada y Telegram está caído, la reunión sigue agendada. Por eso estas
 * funciones devuelven el error en vez de lanzarlo.
 */
import { ajustesEfectivos } from './workspace'

export type ResultadoAviso = { ok: true; messageId: number } | { ok: false; error: string }

/**
 * `workspaceId` decide a qué chat va el aviso: cada empresa puede tener el suyo.
 * Sin él se usa el de la primera, que es el caso de siempre con una sola empresa.
 */
export async function avisar(texto: string, workspaceId?: string | null): Promise<ResultadoAviso> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN no está definida.' }

  let chatId: string
  try {
    chatId = (await ajustesEfectivos(workspaceId)).telegramChatId
  } catch {
    chatId = process.env.TELEGRAM_CHAT_ID ?? ''
  }
  if (!chatId) return { ok: false, error: 'No hay chat de Telegram configurado.' }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: texto,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    const json = (await res.json()) as { ok?: boolean; result?: { message_id: number }; description?: string }
    if (!res.ok || !json.ok) {
      return { ok: false, error: json.description ?? `Telegram devolvió ${res.status}` }
    }
    return { ok: true, messageId: json.result!.message_id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function escapar(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** El formato que pide el spec, tal cual. */
export function formatearAvisoReunion(datos: {
  nombre: string
  cargo: string | null
  empresa: string | null
  inicio: Date
  timezone: string
  score: number | null
  porQue: string
  leadId: string
}): string {
  const fmt = new Intl.DateTimeFormat('es-ES', {
    timeZone: datos.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
  const partes = fmt.formatToParts(datos.inicio)
  const valor = (t: Intl.DateTimeFormatPartTypes) => partes.find((p) => p.type === t)?.value ?? ''
  const fecha = `${valor('weekday')} ${valor('day')} de ${valor('month')}`
  const hora = `${valor('hour')}:${valor('minute')}`

  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const donde = [datos.cargo, datos.empresa].filter(Boolean).join(' en ')

  return [
    '<b>Reunión agendada</b>',
    '',
    `${escapar(datos.nombre)}${donde ? ` — ${escapar(donde)}` : ''}`,
    `${fecha} a las ${hora}`,
    `Score: ${datos.score ?? '—'}/100`,
    `Por qué cualifica: ${escapar(datos.porQue.slice(0, 200))}`,
    '',
    `Ver hilo: ${base}/leads/${datos.leadId}`,
  ].join('\n')
}

export function formatearAvisoEscalado(datos: {
  nombre: string
  motivo: string
  ultimoMensaje: string
  leadId: string
}): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  return [
    '<b>Necesita que entres tú</b>',
    '',
    escapar(datos.nombre),
    `Motivo: ${escapar(datos.motivo)}`,
    '',
    `Último mensaje: «${escapar(datos.ultimoMensaje.slice(0, 300))}»`,
    '',
    `Ver hilo: ${base}/leads/${datos.leadId}`,
  ].join('\n')
}
