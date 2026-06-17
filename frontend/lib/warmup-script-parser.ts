/**
 * Parser de guiones de conversación para el módulo de warmup.
 *
 * Formato esperado (una línea por turno):
 *   Lucas: Che Martín, ¿qué hacés este finde?
 *   Martín: Nada che, tranqui en casa. ¿Por?
 *   Lucas: ¿Te pinta ir a la playa?
 *   Lucas: El sábado temprano, antes de que se llene.
 *
 * Pasos consecutivos del mismo alias = burst (se envían con delay corto).
 * Cambio de alias = turno (delay largo, simula lectura + escritura).
 */

export interface ParsedStep {
  stepOrder:     number
  speakerAlias:  string
  content:       string
}

export interface ParseResult {
  steps:   ParsedStep[]
  aliases: string[]
  errors:  string[]
}

/**
 * Parsea un string multi-línea con formato "Alias: mensaje".
 * Retorna steps, aliases únicos detectados, y errores de formato.
 */
export function parseConversationScript(raw: string): ParseResult {
  const lines   = raw.split('\n').map(l => l.trim()).filter(Boolean)
  const steps:  ParsedStep[] = []
  const aliasSet             = new Set<string>()
  const errors: string[]     = []

  for (let i = 0; i < lines.length; i++) {
    const line      = lines[i]
    const colonIdx  = line.indexOf(':')

    // Línea sin ":" o con ":" como primer caracter
    if (colonIdx <= 0) {
      errors.push(`Línea ${i + 1}: formato inválido — esperado "Nombre: mensaje" (${line.slice(0, 40)})`)
      continue
    }

    const alias   = line.slice(0, colonIdx).trim()
    const content = line.slice(colonIdx + 1).trim()

    if (!alias) {
      errors.push(`Línea ${i + 1}: alias vacío`)
      continue
    }

    if (!content) {
      errors.push(`Línea ${i + 1}: mensaje vacío para "${alias}"`)
      continue
    }

    // Alias con más de 40 caracteres es probablemente un error de formato
    if (alias.length > 40) {
      errors.push(`Línea ${i + 1}: alias demasiado largo ("${alias.slice(0, 20)}...") — ¿olvidaste el ":"?`)
      continue
    }

    aliasSet.add(alias)
    steps.push({ stepOrder: steps.length + 1, speakerAlias: alias, content })
  }

  // Validaciones de conjunto
  if (steps.length > 0 && aliasSet.size < 2) {
    errors.push('La conversación necesita al menos 2 participantes distintos')
  }

  if (steps.length > 200) {
    errors.push('El guión tiene más de 200 pasos — dividilo en varios scripts')
  }

  return {
    steps,
    aliases: Array.from(aliasSet),
    errors,
  }
}

/**
 * Retorna true si el paso en `index` y el siguiente son del mismo speaker.
 * Usado para detectar bursts (mensajes seguidos sin cambio de turno).
 */
export function isBurstStep(steps: ParsedStep[], index: number): boolean {
  if (index >= steps.length - 1) return false
  return steps[index].speakerAlias === steps[index + 1].speakerAlias
}

/**
 * Preview rápido: retorna los primeros N pasos como string legible.
 * Útil para mostrar al usuario antes de guardar el script.
 */
export function previewScript(steps: ParsedStep[], maxSteps = 5): string {
  return steps
    .slice(0, maxSteps)
    .map(s => `${s.speakerAlias}: ${s.content}`)
    .join('\n')
}
