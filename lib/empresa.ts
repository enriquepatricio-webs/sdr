/**
 * Con qué empresa está trabajando el usuario ahora mismo.
 *
 * Es una preferencia de interfaz, no un permiso: cualquiera que tenga sesión ya
 * puede ver todas las empresas. Por eso la cookie no va firmada ni httpOnly, y
 * el servidor la valida contra la lista real antes de usarla (`obtenerWorkspace`
 * cae en la primera empresa si el id no existe).
 *
 * Con una sola empresa esto no se usa para nada: no hay nada que elegir.
 */
export const COOKIE_EMPRESA = 'sdr_empresa'

const UN_ANO = 60 * 60 * 24 * 365

/** Cambia de empresa desde el navegador. Quien llame tiene que refrescar. */
export function elegirEmpresa(id: string): void {
  document.cookie = `${COOKIE_EMPRESA}=${id}; path=/; max-age=${UN_ANO}; samesite=lax`
}
