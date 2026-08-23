/**
 * Reabastecimiento automático de leads.
 *
 * La idea: que el sistema no se pare nunca. Cuando una campaña en marcha se
 * queda sin leads que tocar, busca más él solo en vez de quedarse esperando.
 *
 * LO QUE ESTO NO HACE, Y ES LO IMPORTANTE: llenar la cola no da derecho a
 * enviar ni un mensaje más. Los topes por cuenta, por campaña y por hora los
 * calcula `lib/quota.ts`, que no sabe ni puede saber cuántos leads hay
 * esperando. Tener diez mil leads y tener diez produce exactamente el mismo
 * número de mensajes al día.
 *
 * Lo que sí hay que frenar aquí es el GASTO: cada búsqueda cuesta dinero en
 * Apify y en el modelo, así que hay un tope de búsquedas al día.
 */

export type EstadoCampana = {
  id: string
  name: string
  status: string
  icpId: string | null
  /** Leads en estado 'nuevo' sin tocar todavía. */
  leadsPendientes: number
}

export type NoSeReabastece =
  | 'desactivado'
  | 'ninguna_campana_en_marcha'
  | 'tope_de_busquedas_diarias'
  | 'todas_con_leads'
  | 'sin_icp'

export type PlanReabastecimiento =
  | { procede: false; motivo: NoSeReabastece; detalle?: string }
  | {
      procede: true
      campanas: { id: string; name: string; icpId: string; faltan: number }[]
      busquedasDisponibles: number
    }

export function planificarReabastecimiento(entrada: {
  activo: boolean
  campanas: EstadoCampana[]
  busquedasAutomaticasHoy: number
  maxBusquedasDia: number
  minLeads: number
}): PlanReabastecimiento {
  if (!entrada.activo) return { procede: false, motivo: 'desactivado' }

  const enMarcha = entrada.campanas.filter((c) => c.status === 'running')
  if (!enMarcha.length) return { procede: false, motivo: 'ninguna_campana_en_marcha' }

  const disponibles = entrada.maxBusquedasDia - entrada.busquedasAutomaticasHoy
  if (disponibles <= 0) {
    return {
      procede: false,
      motivo: 'tope_de_busquedas_diarias',
      detalle: `${entrada.busquedasAutomaticasHoy}/${entrada.maxBusquedasDia} búsquedas automáticas hoy`,
    }
  }

  const secas = enMarcha.filter((c) => c.leadsPendientes < entrada.minLeads)
  if (!secas.length) return { procede: false, motivo: 'todas_con_leads' }

  const conIcp = secas.filter((c) => c.icpId)
  if (!conIcp.length) {
    return {
      procede: false,
      motivo: 'sin_icp',
      detalle: 'las campañas sin leads no tienen ICP con el que buscar',
    }
  }

  // Las más secas primero: si solo queda una búsqueda, que vaya donde más falta.
  const ordenadas = [...conIcp].sort((a, b) => a.leadsPendientes - b.leadsPendientes)

  return {
    procede: true,
    busquedasDisponibles: disponibles,
    campanas: ordenadas.slice(0, disponibles).map((c) => ({
      id: c.id,
      name: c.name,
      icpId: c.icpId!,
      faltan: entrada.minLeads - c.leadsPendientes,
    })),
  }
}
