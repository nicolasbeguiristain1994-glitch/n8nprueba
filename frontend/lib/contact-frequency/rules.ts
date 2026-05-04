/**
 * rules.ts — ContactFrequencyEngine
 *
 * Lógica de resolución de reglas y constantes de configuración del motor.
 *
 * Responsabilidad: dada una lista de reglas activas y un contexto de evaluación
 * (operatorId, segMonto, segActividad), retornar la regla más específica que aplica.
 *
 * Orden de precedencia por especificidad (de mayor a menor):
 *   1. operator_id + seg_monto + seg_actividad  (score = 7)
 *   2. operator_id + seg_monto                 (score = 6)
 *   3. operator_id + seg_actividad             (score = 5)
 *   4. operator_id solo                        (score = 4)
 *   5. seg_monto + seg_actividad               (score = 3)
 *   6. seg_monto solo                          (score = 2)
 *   7. seg_actividad solo                      (score = 1)
 *   8. Global (todos null)                     (score = 0)
 *
 * Una regla "aplica" cuando todos sus campos non-null hacen match con el contexto.
 * Un campo null en la regla es un comodín: acepta cualquier valor del contexto.
 */

import type { ContactFrequencyRule, SegMonto, SegActividad } from './types'

// ── Regla global por defecto (fallback de último recurso) ────────────────────
//
// Usada únicamente si la DB no retorna ninguna regla aplicable al contexto.
// En producción, la migración 050 inserta una regla global equivalente, por lo
// que este fallback solo actúa en tests o si alguien borra la regla de la DB.
//
// Los valores son los límites no-negociables del negocio:
//   1 mensaje/día · 2 mensajes/semana · 48h de cool-down

export const DEFAULT_GLOBAL_RULE: Readonly<ContactFrequencyRule> = Object.freeze({
  id:                      '00000000-0000-0000-0000-000000000000',
  operator_id:             null,
  seg_monto:               null,
  seg_actividad:           null,
  max_per_day:             1,
  max_per_week:            2,
  min_hours_between_sends: 48,
  is_active:               true,
  created_at:              new Date(0),
  updated_at:              new Date(0),
})

// ── Umbrales de decisión ──────────────────────────────────────────────────────
//
// Definen los cortes del Risk Score (0–100) para cada decisión.
// Ajustar estos valores cambia la "agresividad" del motor sin tocar la lógica.

/** Risk score máximo para retornar ALLOW. Por encima → DELAY. */
export const ALLOW_THRESHOLD = 30

/** Risk score máximo para retornar DELAY. Por encima → BLOCK. */
export const DELAY_THRESHOLD = 60

// ── Ventana proporcional del cool-down ────────────────────────────────────────

/**
 * Multiplicador que amplía la ventana de cálculo proporcional del cool-down.
 *
 * ## Por qué es necesario (Bug fix)
 *
 * El path proporcional solo se alcanza cuando hoursSinceLastSend >= min_hours
 * (el bloqueo duro captura el caso contrario). Con ventana = min_hours:
 *
 *   ratio = hoursSinceLastSend / min_hours ≥ 1.0
 *   inversePressure = clamp01(1 - ratio) = 0  ← siempre cero → bug
 *
 * Con ventana = min_hours × COOLDOWN_PROPORTIONAL_MULTIPLIER = min_hours × 2:
 *
 *   En el límite exacto del cool-down (hoursSince = min_hours):
 *     ratio = 1/2 = 0.5 → inversePressure = 0.5 → score = 25 × 0.5 = 12.5
 *
 *   Al doble del mínimo (hoursSince = min_hours × 2):
 *     ratio = 1.0 → inversePressure = 0 → score = 0
 *
 * Esto crea una "zona de riesgo moderado" post-cool-down que aporta al score
 * de forma lineal. Con reglas VIP (min_hours=12) el decay va de 12.5 a 0
 * en las siguientes 12 horas, contribuyendo a decisiones DELAY realistas.
 */
export const COOLDOWN_PROPORTIONAL_MULTIPLIER = 2

// ── Pesos del Risk Score ──────────────────────────────────────────────────────
//
// Distribución de los 100 puntos entre los tres componentes.
// La suma DEBE ser 100. Cambiar estos pesos ajusta la sensibilidad relativa
// de cada componente sin modificar la lógica de cálculo.

/**
 * Pesos de cada componente del Risk Score. Suma = 100.
 *
 * daily    (40): límite diario tiene el mayor peso — la restricción más estricta.
 * weekly   (35): límite semanal, segunda restricción más importante.
 * cooldown (25): tiempo desde el último envío — señal complementaria.
 */
export const RISK_WEIGHTS = {
  daily:    40,
  weekly:   35,
  cooldown: 25,
} as const

// ── Resolución de reglas ──────────────────────────────────────────────────────

/**
 * Retorna la regla más específica que aplica al contexto dado.
 *
 * Recibe todas las reglas activas cargadas desde la DB y aplica el algoritmo de
 * resolución por especificidad. Si ninguna regla aplica, retorna DEFAULT_GLOBAL_RULE.
 *
 * Complejidad: O(n) en número de reglas. En producción < 20 reglas → negligible.
 *
 * @param rules        - Reglas activas (de ContactFrequencyRulesRepository)
 * @param operatorId   - Operador que dispara el envío (puede ser null)
 * @param segMonto     - Segmento de monto del jugador (puede ser null/undefined)
 * @param segActividad - Segmento de actividad del jugador (puede ser null/undefined)
 */
export function resolveApplicableRule(
  rules:        ContactFrequencyRule[],
  operatorId:   string | null,
  segMonto:     SegMonto | null | undefined,
  segActividad: SegActividad | null | undefined,
): ContactFrequencyRule {
  // Normalizar undefined → null para simplificar comparaciones
  const monto    = segMonto     ?? null
  const actividad = segActividad ?? null

  const candidates = rules.filter(rule =>
    ruleMatchesContext(rule, operatorId, monto, actividad)
  )

  if (candidates.length === 0) return DEFAULT_GLOBAL_RULE

  // Ordenar: mayor especificidad primero.
  // En empate de especificidad: la más recientemente creada tiene precedencia
  // (permite que una nueva regla sobrescriba una más antigua del mismo scope).
  candidates.sort((a, b) => {
    const specDiff = computeSpecificity(b) - computeSpecificity(a)
    if (specDiff !== 0) return specDiff
    return b.created_at.getTime() - a.created_at.getTime()
  })

  return candidates[0]
}

// ── Helpers privados ──────────────────────────────────────────────────────────

/**
 * Evalúa si una regla aplica al contexto dado.
 *
 * Semántica: un campo null en la regla es un comodín — acepta cualquier valor
 * (incluyendo null) del contexto correspondiente.
 */
function ruleMatchesContext(
  rule:         ContactFrequencyRule,
  operatorId:   string | null,
  segMonto:     SegMonto | null,
  segActividad: SegActividad | null,
): boolean {
  if (rule.operator_id   !== null && rule.operator_id   !== operatorId)   return false
  if (rule.seg_monto     !== null && rule.seg_monto     !== segMonto)     return false
  if (rule.seg_actividad !== null && rule.seg_actividad !== segActividad) return false
  return true
}

/**
 * Cuantifica la especificidad de una regla.
 *
 * Pesos: operator_id=4, seg_monto=2, seg_actividad=1.
 *   Máximo = 7 (los tres campos non-null)
 *   Mínimo = 0 (regla global)
 *
 * El peso de operator_id es mayor porque define el "dominio" del contexto —
 * una regla de un operador específico siempre es más relevante que una
 * regla global de segmento.
 */
function computeSpecificity(rule: ContactFrequencyRule): number {
  let score = 0
  if (rule.operator_id   !== null) score += 4
  if (rule.seg_monto     !== null) score += 2
  if (rule.seg_actividad !== null) score += 1
  return score
}
