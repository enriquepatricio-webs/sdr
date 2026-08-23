/**
 * Montaje del prompt del agente.
 *
 * Este fichero es la razón de que el botón "Probar" sirva de algo: la pantalla
 * de pruebas y el playbook que consume n8n pasan por AQUÍ, por la misma función.
 * Si el ensayo montara el prompt de otra manera, estarías probando un agente
 * distinto del que luego escribe a la gente.
 */
import type { BookingRules, IcpSignal, Objection, QualificationCriterion } from './db/schema'

export type PlaybookParaPrompt = {
  systemPrompt: string
  offer: string
  qualificationCriteria: QualificationCriterion[]
  objections: Objection[]
  bookingRules: BookingRules
}

export type IcpParaPrompt = {
  name: string
  description: string | null
  criteria: IcpSignal[]
  disqualifiers: IcpSignal[]
}

export type ContextoPrompt = {
  empresa: string
  canal: 'linkedin' | 'email' | 'instagram'
}

const NOMBRE_CANAL: Record<ContextoPrompt['canal'], string> = {
  linkedin: 'mensaje directo de LinkedIn',
  instagram: 'mensaje directo de Instagram',
  email: 'email',
}

function seccion(titulo: string, cuerpo: string): string {
  return cuerpo.trim() ? `\n\n# ${titulo}\n\n${cuerpo.trim()}` : ''
}

export function construirSystemPrompt(
  playbook: PlaybookParaPrompt,
  icp: IcpParaPrompt | null,
  contexto: ContextoPrompt,
): string {
  // Los marcadores del playbook se resuelven aquí para que quien escribe el
  // playbook pueda hablar de "{{empresa}}" sin saber de dónde sale el valor.
  const base = playbook.systemPrompt
    .replaceAll('{{empresa}}', contexto.empresa)
    .replaceAll('{{canal}}', NOMBRE_CANAL[contexto.canal])

  const criterios = playbook.qualificationCriteria
    .map(
      (c) =>
        `- [${c.id}] (peso ${c.weight}) ${c.question}` +
        (c.inferable_from ? `\n  Cómo inferirlo sin preguntar: ${c.inferable_from}` : ''),
    )
    .join('\n')

  const objeciones = playbook.objections
    .map((o) => `## "${o.objection}"\n${o.response}`)
    .join('\n\n')

  const r = playbook.bookingRules
  const dias = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo']
  const reglasAgenda = [
    `- Duración de la reunión: ${r.duration_min} minutos.`,
    `- No propongas nada que empiece antes de ${r.min_notice_hours} h desde ahora.`,
    `- Deja ${r.buffer_min} min de colchón antes y después de cada reunión.`,
    `- Horario: ${r.working_hours.from}–${r.working_hours.to} (${r.timezone}), ${r.working_hours.days.map((d) => dias[d - 1]).join(', ')}.`,
    `- Ofrece como mucho ${r.max_slots_offered} huecos por mensaje. Más satura y retrasa la decisión.`,
    `- No puedes agendar con un score por debajo de ${r.min_score_to_book}. Es un umbral duro, no una guía.`,
  ].join('\n')

  const icpTexto = icp
    ? [
        icp.description ?? '',
        '',
        'Señales de que ENCAJA:',
        ...icp.criteria.map((c) => `- ${c.signal}${c.source ? ` (se ve en: ${c.source})` : ''}`),
        '',
        'Señales de que hay que DESCARTAR sin conversación:',
        ...icp.disqualifiers.map((d) => `- ${d.signal}${d.source ? ` (se ve en: ${d.source})` : ''}`),
      ].join('\n')
    : ''

  return [
    base.trim(),
    seccion('Qué vendemos', playbook.offer),
    seccion(`A quién buscamos: ${icp?.name ?? 'sin ICP definido'}`, icpTexto),
    seccion(
      'Qué tienes que averiguar (máximo 2 preguntas en toda la conversación)',
      criterios
        ? `${criterios}\n\nEl resto lo infieres del perfil y de lo que te cuente. Registra el resultado con \`registrar_cualificacion\`.`
        : '',
    ),
    seccion('Objeciones y cómo responderlas', objeciones),
    seccion('Reglas de agendado', reglasAgenda),
  ]
    .filter(Boolean)
    .join('')
}
