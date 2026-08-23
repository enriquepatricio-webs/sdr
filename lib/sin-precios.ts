/**
 * Ningún mensaje sale con una cifra de dinero dentro.
 *
 * No basta con pedírselo al prompt, por dos motivos. Uno: una instrucción es una
 * petición, no una condición. Y dos, el que no se ve: el contexto de la empresa
 * sale de scrapear su propia web, y las webs llevan tarifas — así que los
 * precios vuelven a entrar en el prompt por detrás después de haberlos quitado
 * del playbook.
 *
 * Está en su propio fichero porque hay dos puertas de salida hacia una persona
 * (`/api/messages/send` y los DMs de los lead magnets) y con una copia en cada
 * una era cuestión de tiempo que se endureciera una y no la otra.
 *
 * Se prefiere bloquear de más: un mensaje devuelto al agente para que lo
 * reescriba cuesta unos céntimos; un precio suelto por chat cuesta la venta.
 */
export const MENCIONA_DINERO =
  /(€|\$|£|\bEUR\b|\bUSD\b|\bGBP\b|\beuros?\b|\bd[oó]lares?\b|\blibras?\b)/i

export function mencionaDinero(texto: string): boolean {
  return MENCIONA_DINERO.test(texto)
}

/** Lo que se le dice al agente cuando se le bloquea un mensaje. */
export const AVISO_SIN_PRECIOS =
  'Ese mensaje menciona dinero y no puede salir. Reescríbelo sin cifras ni monedas: explica por qué el número se da en la reunión y cierra pidiendo el día.'
