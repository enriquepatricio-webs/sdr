import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'

export const dynamic = 'force-dynamic'

/**
 * Averigua el chat_id de Telegram por ti, para no tener que ir a @userinfobot.
 *
 * Lee lo que el bot ha recibido con getUpdates y devuelve los chats distintos
 * que aparecen. Tres cosas que hay que saber de getUpdates y que deciden todo
 * este fichero:
 *
 *  1. NO se puede usar si el bot tiene un webhook puesto: Telegram contesta 409.
 *     Aquí NO se borra ese webhook. Casi seguro es el nodo de Telegram de n8n, y
 *     quitárselo en silencio le rompe un workflow en producción para ahorrarle
 *     un copiar-pegar.
 *  2. Leer con `offset` CONFIRMA las updates y Telegram las borra. Por eso se
 *     llama SIN offset: así esto es de solo lectura y no le quita mensajes a
 *     nadie que esté escuchando el mismo bot.
 *  3. Telegram solo guarda las updates 24 h. Si el bot no ha recibido nada
 *     todavía, la lista sale vacía y no es un error: hay que escribirle primero.
 */

type ChatTg = {
  id: number
  type: string
  title?: string
  username?: string
  first_name?: string
}

type Update = {
  message?: { chat: ChatTg }
  edited_message?: { chat: ChatTg }
  channel_post?: { chat: ChatTg }
  /** Llega al pulsar "Start" o al meter el bot en un grupo, aunque no escriba nadie. */
  my_chat_member?: { chat: ChatTg }
}

type Respuesta<T> = { ok: boolean; result?: T; description?: string; error_code?: number }

async function api<T>(token: string, metodo: string, query = ''): Promise<Respuesta<T>> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${metodo}${query}`, {
      cache: 'no-store',
    })
    return (await res.json()) as Respuesta<T>
  } catch {
    // El token va dentro de la URL: el error de fetch no se propaga tal cual
    // porque puede llevarla dentro y acabaría en la respuesta HTTP.
    return { ok: false, description: 'No se pudo hablar con la API de Telegram.' }
  }
}

function nombreDe(c: ChatTg): string {
  return (
    c.title ||
    [c.first_name, c.username ? `@${c.username}` : null].filter(Boolean).join(' ') ||
    String(c.id)
  )
}

export async function GET() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    return jsonError('No hay TELEGRAM_BOT_TOKEN. Crea el bot con @BotFather y ponla en el entorno.', 409)
  }

  // getMe valida el token y da el @usuario, que es lo que hace falta para el
  // enlace "escríbele". Sin esto el error sería "no encuentro chats" cuando en
  // realidad el token está mal.
  const yo = await api<{ username: string }>(token, 'getMe')
  if (!yo.ok || !yo.result) {
    return jsonError(`El token del bot no vale: ${yo.description ?? 'Telegram lo rechazó'}`, 409)
  }
  const bot = yo.result.username
  const enlace = `https://t.me/${bot}`

  const webhook = await api<{ url?: string }>(token, 'getWebhookInfo')
  if (webhook.result?.url) {
    return jsonError(
      'Este bot tiene un webhook puesto (seguramente el nodo de Telegram de n8n), y mientras esté ahí Telegram no deja leer los mensajes desde aquí. Escribe el chat_id a mano: habla con @userinfobot y pega el número.',
      409,
      { bot, enlace, webhook: webhook.result.url },
    )
  }

  const updates = await api<Update[]>(token, 'getUpdates', '?limit=100&timeout=0')
  if (!updates.ok) {
    if (updates.error_code === 409) {
      return jsonError(
        'Hay otro proceso leyendo este bot ahora mismo (n8n en modo polling, o esta misma pantalla en otra pestaña). Ciérralo y vuelve a probar.',
        409,
        { bot, enlace },
      )
    }
    return jsonError(`Telegram: ${updates.description ?? 'respuesta inesperada'}`, 502, { bot, enlace })
  }

  // Puede haber varios: tu chat privado, un grupo, un canal. Se devuelven todos
  // y elige el usuario. Mandar los avisos al grupo equivocado se arregla mal.
  const porId = new Map<number, { id: string; tipo: string; nombre: string }>()
  for (const u of updates.result ?? []) {
    const c = u.message?.chat ?? u.edited_message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat
    if (!c) continue
    porId.set(c.id, { id: String(c.id), tipo: c.type, nombre: nombreDe(c) })
  }

  return NextResponse.json({
    bot,
    enlace,
    chats: [...porId.values()],
    // El caso de cero no es un fallo: es que el bot todavía no ha recibido nada.
    pista:
      porId.size === 0
        ? `Escríbele algo a @${bot} (vale con /start) y vuelve a pulsar. Telegram solo guarda los mensajes 24 h.`
        : null,
  })
}
