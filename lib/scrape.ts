/**
 * Lectura de webs y perfiles, para escribir sabiendo a quién.
 *
 * Un mensaje en frío que no demuestra que te has mirado a la persona es
 * indistinguible de una plantilla, y se contesta igual que una plantilla. Esto
 * es lo que convierte "hola, vendemos X" en "vi que en Verto Ops todo el
 * pipeline viene de referidos".
 *
 * Todo aquí es de mejor esfuerzo: si una web no responde o un perfil está
 * cerrado, se sigue adelante con menos contexto. Nunca se bloquea el envío por
 * no haber podido leer algo.
 */
import { ACTORES_LECTURA, runSync } from './apify'

/**
 * Cuánto se espera a una web ajena. Corto a propósito: esto va delante de cada
 * primer mensaje y una web caída no puede frenar la cola.
 */
const ESPERA_MS = 12_000

/** Recorta texto a un tamaño que no reviente el prompt ni la factura. */
function recortar(texto: string, maximo: number): string {
  const limpio = texto.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return limpio.length <= maximo ? limpio : `${limpio.slice(0, maximo)}…`
}

export type LecturaWeb = { url: string; texto: string; titulo?: string }

/**
 * Lee una web. Se limita a unas pocas páginas a propósito: para escribir un
 * mensaje hacen falta la propuesta de valor y a quién se dirigen, no el blog
 * entero.
 */
export async function leerWeb(
  url: string,
  opts: { maxPaginas?: number; maxCaracteres?: number } = {},
): Promise<LecturaWeb | null> {
  const limpia = url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`

  /**
   * Se descarga la portada y ya está. Sin Apify.
   *
   * Antes esto lanzaba `apify/website-content-crawler` con hasta cuatro páginas
   * y proxy, una vez por CADA lead. Con 231 leads enriquecidos frente a 64
   * búsquedas de prospección, el enriquecimiento se comía casi cuatro veces más
   * créditos que la razón por la que se paga Apify.
   *
   * Y no hacía falta: lo que se busca aquí es la propuesta de valor y a quién se
   * dirigen, que está en la portada. Bajarla con `fetch` es gratis y da
   * prácticamente lo mismo. Los créditos se quedan para conseguir leads, que es
   * lo que no se puede hacer de otra forma.
   */
  try {
    const res = await fetch(limpia, {
      redirect: 'follow',
      signal: AbortSignal.timeout(ESPERA_MS),
      headers: {
        // Sin un agente reconocible, bastantes webs devuelven 403 y nos
        // quedaríamos sin contexto creyendo que la web no existe.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    })
    if (!res.ok) return null
    if (!(res.headers.get('content-type') ?? '').includes('html')) return null

    const html = (await res.text()).slice(0, 400_000)
    const titulo = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()
    const texto = textoDeHtml(html)
    if (!texto.trim()) return null

    return {
      url: limpia,
      titulo: titulo || undefined,
      texto: recortar(texto, opts.maxCaracteres ?? 6000),
    }
  } catch {
    // Una web caída, un certificado malo o un timeout no son un error nuestro:
    // se escribe con menos contexto y se sigue.
    return null
  }
}

/**
 * El texto visible de una página, sin etiquetas.
 *
 * No es un analizador de HTML y no pretende serlo: quita lo que no se lee
 * —guiones, estilos, cabeceras de navegación— y deja las frases. Para decidir
 * qué vende una empresa es más que suficiente.
 */
function textoDeHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&(quot|#34);/g, '"')
    .replace(/&(apos|#39);/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

export type LecturaPerfil = { texto: string; datos: Record<string, unknown> }

/**
 * Lee un perfil de LinkedIn. Sin cookies: no arriesga la cuenta del usuario.
 *
 * Apagado por defecto. Es el único lector que sigue costando créditos de Apify
 * —un perfil de LinkedIn no se puede bajar con un `fetch`, hace falta alguien
 * que lo resuelva— y esos créditos se reservan para conseguir leads, que es lo
 * que no se puede hacer de ninguna otra forma.
 *
 * Con esto apagado el agente escribe con el titular y la empresa, que es lo que
 * ya trae el lead. Para volver a encenderlo: APIFY_PERFILES=1.
 */
export async function leerPerfilLinkedin(url: string): Promise<LecturaPerfil | null> {
  if (process.env.APIFY_PERFILES !== '1') return null
  try {
    const items = await runSync<Record<string, any>>(
      ACTORES_LECTURA.perfilLinkedin,
      { urls: [url], profileScraperMode: 'Full' },
      { maxItems: 1, timeoutSecs: 120 },
    )
    const p = items[0]
    if (!p) return null

    // Se queda solo lo que sirve para escribir un mensaje. El resto es ruido
    // que cuesta tokens y no cambia lo que se le va a decir.
    const partes = [
      p.headline && `Titular: ${p.headline}`,
      p.about && `Sobre sí: ${recortar(String(p.about), 900)}`,
      p.location?.linkedinText && `Ubicación: ${p.location.linkedinText}`,
      Array.isArray(p.experience) &&
        p.experience.length > 0 &&
        `Trayectoria: ${p.experience
          .slice(0, 3)
          .map((e: any) => `${e.position ?? ''} en ${e.companyName ?? ''}`.trim())
          .filter(Boolean)
          .join(' · ')}`,
      Array.isArray(p.education) &&
        p.education.length > 0 &&
        `Formación: ${p.education.slice(0, 2).map((e: any) => e.schoolName).filter(Boolean).join(' · ')}`,
    ].filter(Boolean)

    if (!partes.length) return null
    return { texto: partes.join('\n'), datos: p }
  } catch {
    return null
  }
}


/**
 * Adivina la web de una empresa a partir de su nombre.
 *
 * Deliberadamente conservador: solo prueba el dominio obvio. Adivinar mal y
 * scrapear la web de otra empresa es peor que no tener contexto, porque el
 * agente escribiría con datos de un tercero como si fueran del prospecto.
 */
export function dominioProbable(empresa: string | null): string | null {
  if (!empresa) return null
  const base = empresa
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(s\.?l\.?|s\.?a\.?|inc|llc|ltd|gmbh|studio|group|agency)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
  return base.length >= 3 && base.length <= 30 ? `https://${base}.com` : null
}
