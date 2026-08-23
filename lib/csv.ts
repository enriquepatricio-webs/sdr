/**
 * Lector de CSV según RFC 4180.
 *
 * Se escribe a mano en vez de añadir una dependencia porque son cuarenta líneas,
 * pero NO se resuelve con `split(',')`: en una lista de leads reales hay comas
 * dentro de comillas en casi todos los nombres de empresa ("Acme, S.L."), y un
 * parser ingenuo desplaza todas las columnas de esa fila sin avisar. El
 * resultado sería escribirle a la persona equivocada con el nombre de otra.
 */

export type FilaCsv = Record<string, string>

/** Divide respetando comillas, comillas escapadas ("") y saltos de línea dentro de campo. */
export function parsearCsv(texto: string, separador?: string): FilaCsv[] {
  const limpio = texto.replace(/^﻿/, '') // BOM de Excel
  const sep = separador ?? detectarSeparador(limpio)

  const filas: string[][] = []
  let campo = ''
  let fila: string[] = []
  let enComillas = false

  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i]

    if (enComillas) {
      if (c === '"') {
        if (limpio[i + 1] === '"') {
          campo += '"'
          i++
        } else {
          enComillas = false
        }
      } else {
        campo += c
      }
      continue
    }

    if (c === '"') {
      enComillas = true
    } else if (c === sep) {
      fila.push(campo)
      campo = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && limpio[i + 1] === '\n') i++
      fila.push(campo)
      filas.push(fila)
      fila = []
      campo = ''
    } else {
      campo += c
    }
  }
  if (campo !== '' || fila.length) {
    fila.push(campo)
    filas.push(fila)
  }

  const utiles = filas.filter((f) => f.some((c) => c.trim() !== ''))
  if (utiles.length < 2) return []

  const cabeceras = utiles[0].map((h) => h.trim())
  return utiles.slice(1).map((f) =>
    Object.fromEntries(cabeceras.map((h, i) => [h, (f[i] ?? '').trim()])),
  )
}

/** Excel en España exporta con punto y coma. Se decide por la primera línea. */
export function detectarSeparador(texto: string): string {
  const primera = texto.split(/\r?\n/)[0] ?? ''
  const fuera = primera.replace(/"[^"]*"/g, '')
  const puntoYComa = (fuera.match(/;/g) ?? []).length
  const comas = (fuera.match(/,/g) ?? []).length
  const tabs = (fuera.match(/\t/g) ?? []).length
  if (tabs > puntoYComa && tabs > comas) return '\t'
  return puntoYComa > comas ? ';' : ','
}

/** Campos de `leads` que un CSV puede rellenar. */
export const CAMPOS_IMPORTABLES = [
  { campo: 'fullName', etiqueta: 'Nombre completo', obligatorio: true },
  { campo: 'headline', etiqueta: 'Titular / cargo', obligatorio: false },
  { campo: 'company', etiqueta: 'Empresa', obligatorio: false },
  { campo: 'linkedinUrl', etiqueta: 'URL de LinkedIn', obligatorio: false },
  { campo: 'instagramUsername', etiqueta: 'Usuario de Instagram', obligatorio: false },
  { campo: 'email', etiqueta: 'Email', obligatorio: false },
  { campo: 'providerId', etiqueta: 'ID de perfil (Unipile)', obligatorio: false },
] as const

export type CampoImportable = (typeof CAMPOS_IMPORTABLES)[number]['campo']

/**
 * Adivina qué columna del CSV va a qué campo, para que el usuario solo tenga
 * que corregir lo que falle en vez de mapear siete columnas a mano.
 */
export function adivinarMapeo(cabeceras: string[]): Partial<Record<CampoImportable, string>> {
  const pistas: Record<CampoImportable, string[]> = {
    fullName: ['nombre completo', 'full name', 'fullname', 'name', 'nombre', 'contacto'],
    headline: ['headline', 'titular', 'cargo', 'title', 'puesto', 'position', 'job title'],
    company: ['company', 'empresa', 'organizacion', 'organización', 'organization', 'compañia'],
    linkedinUrl: ['linkedin', 'linkedin url', 'profile url', 'perfil', 'url'],
    instagramUsername: ['instagram', 'ig', 'usuario instagram', 'handle', 'username'],
    email: ['email', 'correo', 'e-mail', 'mail', 'correo electronico'],
    providerId: ['provider id', 'provider_id', 'unipile', 'id perfil'],
  }

  const normalizar = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .trim()

  const mapeo: Partial<Record<CampoImportable, string>> = {}
  const usadas = new Set<string>()

  // Dos pasadas: primero coincidencias exactas, luego parciales. Sin esto una
  // columna "Email" podría quedarse enganchada a "linkedinUrl" por contener "url".
  for (const exacta of [true, false]) {
    for (const [campo, alias] of Object.entries(pistas) as [CampoImportable, string[]][]) {
      if (mapeo[campo]) continue
      const encontrada = cabeceras.find((h) => {
        if (usadas.has(h)) return false
        const n = normalizar(h)
        return exacta ? alias.includes(n) : alias.some((a) => n.includes(a))
      })
      if (encontrada) {
        mapeo[campo] = encontrada
        usadas.add(encontrada)
      }
    }
  }
  return mapeo
}
