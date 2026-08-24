/**
 * Cliente de Unipile: LinkedIn, Instagram y email por una sola API.
 *
 * Endpoints verificados contra developer.unipile.com:
 *   POST /chats                      abrir conversación nueva   (multipart/form-data)
 *   POST /chats/{id}/messages        responder en el hilo        (multipart/form-data)
 *   POST /users/invite               invitación de contacto      (application/json)
 *   GET  /chats/{id}/messages        leer el hilo
 *
 * Los dos primeros son multipart aunque no lleven fichero: es lo que documenta
 * Unipile, y mandarlos como JSON devuelve un 400 poco explicativo.
 */

export type UnipileProvider = 'LINKEDIN' | 'INSTAGRAM' | 'GOOGLE' | 'MICROSOFT' | 'IMAP'

/** Máximo que admite Unipile en el texto que acompaña a una invitación. */
/**
 * Tope real de la nota de una invitación de LinkedIn.
 *
 * Estaba en 300, que es lo que dice la documentación, pero con 250 caracteres
 * Unipile devolvió 400 `too_many_characters` en producción: las cuentas sin
 * Premium admiten menos. 200 pasa en todas.
 */
export const MAX_CARACTERES_INVITACION = 200

/**
 * Un fallo NUESTRO, detectado antes de tocar la red.
 *
 * Se distingue de `UnipileError` porque cambia lo que hay que hacer: si la
 * petición nunca salió, el mensaje no pudo llegar al prospecto, así que no hay
 * riesgo de duplicarlo y el lead no debe quemarse. Con un error de Unipile no
 * se sabe si salió, y por eso ahí no se reintenta nunca.
 */
export class ErrorAntesDeEnviar extends Error {}

export class UnipileError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'UnipileError'
  }
}

function configuracion() {
  const apiKey = process.env.UNIPILE_API_KEY
  const dsn = process.env.UNIPILE_DSN
  if (!apiKey) throw new Error('UNIPILE_API_KEY no está definida.')
  if (!dsn) throw new Error('UNIPILE_DSN no está definida. Formato: api8.unipile.com:13843')
  // El DSN se guarda sin esquema; aceptamos las dos formas por si acaso.
  const base = dsn.startsWith('http') ? dsn : `https://${dsn}`
  return { apiKey, base: `${base.replace(/\/$/, '')}/api/v1` }
}

async function pedir<T>(
  ruta: string,
  init: { method: string; body?: BodyInit; json?: boolean },
): Promise<T> {
  const { apiKey, base } = configuracion()
  const res = await fetch(`${base}${ruta}`, {
    method: init.method,
    headers: {
      'X-API-KEY': apiKey,
      Accept: 'application/json',
      // En multipart NO se pone Content-Type a mano: fetch tiene que añadir el
      // boundary. Ponerlo rompe la petición de una forma difícil de depurar.
      ...(init.json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body,
    cache: 'no-store',
  })

  const texto = await res.text()
  if (!res.ok) {
    throw new UnipileError(`Unipile respondió ${res.status}: ${texto.slice(0, 300)}`, res.status, texto)
  }
  return (texto ? JSON.parse(texto) : {}) as T
}

/* -------------------------------------------------------------------------- */
/* Enviar                                                                      */
/* -------------------------------------------------------------------------- */

export type ChatIniciado = { chat_id: string; message_id: string }

/**
 * Abre una conversación nueva.
 *
 * En LinkedIn solo se puede con contactos ya aceptados, salvo InMail. Para un
 * desconocido el orden es: invitación primero, mensaje cuando la acepte.
 */
export async function iniciarChat(opciones: {
  accountId: string
  attendeeId: string
  texto: string
  /** InMail de LinkedIn Premium: permite escribir sin ser contacto. Consume cuota. */
  inmail?: boolean
}): Promise<ChatIniciado> {
  const form = new FormData()
  form.append('account_id', opciones.accountId)
  form.append('attendees_ids', opciones.attendeeId)
  form.append('text', opciones.texto)
  if (opciones.inmail) {
    form.append('linkedin[api]', 'classic')
    form.append('linkedin[inmail]', 'true')
  }
  return pedir<ChatIniciado>('/chats', { method: 'POST', body: form })
}

export type MensajeEnviado = { message_id: string }

/** Responde dentro de un hilo que ya existe. */
export async function enviarEnChat(chatId: string, texto: string): Promise<MensajeEnviado> {
  const form = new FormData()
  form.append('text', texto)
  return pedir<MensajeEnviado>(`/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    body: form,
  })
}

export type InvitacionEnviada = { invitation_id: string; usage?: number }

/**
 * Invitación de contacto. En LinkedIn es el primer toque de una campaña en frío.
 *
 * El texto no puede pasar de 300 caracteres. Se falla en vez de recortar: un
 * mensaje de ventas cortado a la mitad es peor que no enviarlo, y recortarlo en
 * silencio esconde un playbook que está generando mensajes demasiado largos.
 */
export async function invitar(opciones: {
  accountId: string
  providerId: string
  mensaje?: string
  /** LinkedIn a veces exige el email para invitar. */
  email?: string
}): Promise<InvitacionEnviada> {
  if (opciones.mensaje && opciones.mensaje.length > MAX_CARACTERES_INVITACION) {
    throw new ErrorAntesDeEnviar(
      `La nota de invitación tiene ${opciones.mensaje.length} caracteres y el máximo es ${MAX_CARACTERES_INVITACION}. Acorta el primer toque en el playbook.`,
    )
  }
  return pedir<InvitacionEnviada>('/users/invite', {
    method: 'POST',
    json: true,
    body: JSON.stringify({
      account_id: opciones.accountId,
      provider_id: opciones.providerId,
      ...(opciones.mensaje ? { message: opciones.mensaje } : {}),
      ...(opciones.email ? { user_email: opciones.email } : {}),
    }),
  })
}

/* -------------------------------------------------------------------------- */
/* Leer                                                                        */
/* -------------------------------------------------------------------------- */

export type MensajeUnipile = {
  id: string
  text: string | null
  is_sender?: number | boolean
  timestamp?: string
  sender_id?: string
}

/**
 * Manda un correo desde la cuenta del usuario.
 *
 * El correo NO va por `/chats`: esa es la API de mensajería de LinkedIn e
 * Instagram, y una cuenta de Gmail conectada responde a ella con
 * "Provided account is not designed for this feature". Unipile tiene un
 * endpoint aparte que enruta a Gmail, Microsoft Graph o SMTP según el
 * proveedor, y el correo aparece en la carpeta de enviados del usuario.
 *
 * Se descubrió con cuatro envíos fallidos en producción: se registraban como
 * intentos y quemaban el lead sin que saliera nada.
 */
export async function enviarCorreo(opciones: {
  accountId: string
  destinatario: string
  asunto: string
  cuerpo: string
}): Promise<MensajeEnviado> {
  return pedir<MensajeEnviado>('/emails', {
    method: 'POST',
    json: true,
    body: JSON.stringify({
      account_id: opciones.accountId,
      to: [{ identifier: opciones.destinatario }],
      subject: opciones.asunto,
      body: opciones.cuerpo,
    }),
  })
}

export async function listarMensajes(
  chatId: string,
  limite = 50,
): Promise<{ items: MensajeUnipile[] }> {
  return pedir<{ items: MensajeUnipile[] }>(
    `/chats/${encodeURIComponent(chatId)}/messages?limit=${limite}`,
    { method: 'GET' },
  )
}

/* -------------------------------------------------------------------------- */
/* Conectar cuentas desde el dashboard                                         */
/* -------------------------------------------------------------------------- */

export type CuentaUnipile = {
  id: string
  type: string
  name: string
  created_at: string
  sources?: { id: string; status: string }[]
}

/** Cuentas ya conectadas en Unipile. Se usa para sincronizarlas al dashboard. */
export async function listarCuentas(): Promise<CuentaUnipile[]> {
  const r = await pedir<{ items?: CuentaUnipile[] }>('/accounts?limit=100', { method: 'GET' })
  return r.items ?? []
}

/**
 * Genera el enlace del asistente de conexión de Unipile.
 *
 * Es la forma correcta de conectar una cuenta desde el dashboard: el usuario
 * mete sus credenciales de LinkedIn o Instagram en la pantalla de Unipile, no
 * en la nuestra. Nosotros nunca vemos ni almacenamos esa contraseña.
 */
export async function crearEnlaceDeConexion(opciones: {
  proveedores: UnipileProvider[]
  urlExito: string
  urlFallo: string
  urlAviso?: string
  referencia?: string
  minutosDeVida?: number
}): Promise<{ url: string }> {
  const { base } = configuracion()
  const expira = new Date(Date.now() + (opciones.minutosDeVida ?? 30) * 60_000)

  return pedir<{ url: string }>('/hosted/accounts/link', {
    method: 'POST',
    json: true,
    body: JSON.stringify({
      type: 'create',
      providers: opciones.proveedores,
      // Unipile necesita saber a qué instancia suya volver.
      api_url: base.replace(/\/api\/v1$/, ''),
      expiresOn: expira.toISOString(),
      success_redirect_url: opciones.urlExito,
      failure_redirect_url: opciones.urlFallo,
      ...(opciones.urlAviso ? { notify_url: opciones.urlAviso } : {}),
      ...(opciones.referencia ? { name: opciones.referencia } : {}),
    }),
  })
}

/** Tipo de cuenta de Unipile → canal nuestro. */
export function canalDeProveedor(tipo: string): 'linkedin' | 'instagram' | 'email' | null {
  const t = tipo.toUpperCase()
  if (t === 'LINKEDIN') return 'linkedin'
  if (t === 'INSTAGRAM') return 'instagram'
  if (['GOOGLE', 'GOOGLE_OAUTH', 'MICROSOFT', 'OUTLOOK', 'IMAP', 'MAIL', 'ICLOUD'].includes(t)) {
    return 'email'
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Webhook de mensaje entrante                                                 */
/* -------------------------------------------------------------------------- */

export type WebhookMensaje = {
  event?: string
  account_id?: string
  account_type?: string
  account_info?: { user_id?: string; type?: string; feature?: string }
  chat_id?: string
  message_id?: string
  message?: string
  timestamp?: string
  sender?: {
    attendee_id?: string
    attendee_name?: string
    attendee_provider_id?: string
    attendee_profile_url?: string
  }
}

export type EventoEntrante = {
  esNuestro: boolean
  messageId: string
  chatId: string
  accountId: string
  texto: string
  remitenteProviderId: string | null
  remitenteNombre: string | null
  remitenteUrl: string | null
  ocurridoEn: Date
}

/**
 * Normaliza el webhook y, sobre todo, dice si el mensaje lo hemos enviado
 * NOSOTROS.
 *
 * Esto no es un detalle. La documentación de Unipile lo dice tal cual: "Sent
 * messages are included in message_received". El propio mensaje que acaba de
 * mandar el agente vuelve por el webhook. Sin esta comprobación, el agente lee
 * su mensaje como si fuera una respuesta del prospecto, contesta, ese mensaje
 * vuelve otra vez, y tienes un bucle escribiendo a una persona real.
 *
 * La forma de distinguirlo que documenta Unipile es comparar
 * `account_info.user_id` con `sender.attendee_provider_id`.
 */
export function interpretarWebhook(payload: WebhookMensaje): EventoEntrante | null {
  if (payload.event && payload.event !== 'message_received') return null

  const messageId = payload.message_id
  const chatId = payload.chat_id
  if (!messageId || !chatId) return null

  const nuestroUserId = payload.account_info?.user_id
  const remitente = payload.sender?.attendee_provider_id ?? null

  return {
    esNuestro: Boolean(nuestroUserId && remitente && nuestroUserId === remitente),
    messageId,
    chatId,
    accountId: payload.account_id ?? '',
    texto: payload.message ?? '',
    remitenteProviderId: remitente,
    remitenteNombre: payload.sender?.attendee_name ?? null,
    remitenteUrl: payload.sender?.attendee_profile_url ?? null,
    ocurridoEn: payload.timestamp ? new Date(payload.timestamp) : new Date(),
  }
}

/** Canal de la campaña → tipo de cuenta de Unipile. */
export function proveedorDeCanal(canal: 'linkedin' | 'email' | 'instagram'): UnipileProvider {
  return canal === 'linkedin' ? 'LINKEDIN' : canal === 'instagram' ? 'INSTAGRAM' : 'GOOGLE'
}

/* -------------------------------------------------------------------------- */
/* Resolver un usuario por su nombre público                                   */
/* -------------------------------------------------------------------------- */

export type UsuarioUnipile = {
  provider_id?: string
  id?: string
  public_identifier?: string
  name?: string
  /**
   * Grado de conexión en LinkedIn: "DISTANCE_1" es contacto directo.
   * A quien no lo es no se le puede mandar un DM, solo una invitación.
   */
  network_distance?: string
}



/**
 * Recorta la nota SIN cortar una frase por la mitad.
 *
 * Es lo primero que el prospecto ve de nosotros; una frase cortada a medias con
 * puntos suspensivos da la impresión contraria a la que busca el playbook.
 * Se corta en el último punto que quepa, y si no hay ninguno, en la última
 * palabra entera.
 */
export function notaDeInvitacion(texto: string): string {
  const limpio = texto.trim()
  if (limpio.length <= MAX_CARACTERES_INVITACION) return limpio

  const trozo = limpio.slice(0, MAX_CARACTERES_INVITACION)
  const finDeFrase = Math.max(trozo.lastIndexOf('. '), trozo.lastIndexOf('? '), trozo.lastIndexOf('! '))
  if (finDeFrase > MAX_CARACTERES_INVITACION * 0.5) return trozo.slice(0, finDeFrase + 1)

  // Los puntos suspensivos cuentan: si se recorta a MAX y se añaden, el
  // resultado tiene MAX+1 y lo rechaza la validación de dos líneas más abajo.
  const finDePalabra = trozo.lastIndexOf(' ')
  const corte = finDePalabra > 0 ? finDePalabra : MAX_CARACTERES_INVITACION - 1
  return `${trozo.slice(0, corte).trimEnd()}…`
}

/** De una URL de perfil de LinkedIn saca el identificador público. */
export function identificadorDeUrlLinkedin(url: string | null): string | null {
  if (!url) return null
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i)
  return m?.[1] ? decodeURIComponent(m[1]) : null
}

/**
 * De "@ana" al identificador que Unipile necesita para abrir un chat.
 *
 * Hace falta porque un comentario de Instagram solo da el nombre de usuario, y
 * `iniciarChat` pide un `attendee_id`. Se resuelve contra Unipile y no contra el
 * id numérico que devuelve el scraper: el que tiene que reconocer el id es
 * Unipile, así que es Unipile quien debe darlo.
 */
export async function obtenerUsuario(
  accountId: string,
  identificador: string,
): Promise<UsuarioUnipile> {
  return pedir<UsuarioUnipile>(
    `/users/${encodeURIComponent(identificador)}?account_id=${encodeURIComponent(accountId)}`,
    { method: 'GET' },
  )
}
