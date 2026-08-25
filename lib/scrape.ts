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

  try {
    const items = await runSync<{ url?: string; text?: string; markdown?: string; metadata?: { title?: string } }>(
      ACTORES_LECTURA.web,
      {
        startUrls: [{ url: limpia }],
        maxCrawlPages: opts.maxPaginas ?? 4,
        crawlerType: 'cheerio',
        saveMarkdown: true,
        proxyConfiguration: { useApifyProxy: true },
      },
      { maxItems: opts.maxPaginas ?? 4, timeoutSecs: 120 },
    )

    const texto = items
      .map((i) => i.markdown ?? i.text ?? '')
      .filter(Boolean)
      .join('\n\n---\n\n')

    if (!texto.trim()) return null
    return {
      url: limpia,
      titulo: items[0]?.metadata?.title,
      texto: recortar(texto, opts.maxCaracteres ?? 6000),
    }
  } catch {
    return null
  }
}

export type LecturaPerfil = { texto: string; datos: Record<string, unknown> }

/** Lee un perfil de LinkedIn. Sin cookies: no arriesga la cuenta del usuario. */
export async function leerPerfilLinkedin(url: string): Promise<LecturaPerfil | null> {
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
