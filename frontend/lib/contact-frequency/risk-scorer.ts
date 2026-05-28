/**
 * risk-scorer.ts — ContactFrequencyEngine
 *
 * Calcula el Risk Score (0–100) y la decisión final (ALLOW / DELAY / BLOCK)
 * a partir del perfil de frecuencia del contacto y la regla aplicable.
 *
 * Arquitectura de dos niveles:
 *
 * Nivel 1 — Bloqueos duros (score = 100, BLOCK inmediato):
 *   Cualquiera de estas condiciones dispara un bloqueo sin importar el score:
 *   ① sentToday    >= max_per_day                → límite diario superado
 *   ② sentThisWeek >= max_per_week               → límite semanal superado
 *   ③ hoursSinceLastSend < min_hours_between_sends → cool-down activo
 *
 * Nivel 2 — Score proporcional (cuando no hay bloqueo duro):
 *   Tres componentes independientes suman al score total (0–100):
 *   ─ dailyScore    (0→40): ratio sentToday / max_per_day
 *   ─ weeklyScore   (0→35): ratio sentThisWeek / max_per_week
 *   ─ cooldownScore (0→25): presión inversa de horas desde último envío
 *
 * Umbrales de decisión (configurables via ScorerConfig):
 *   score 0–30  → ALLOW
 *   score 31–60 → DELAY
 *   score 61–100 → BLOCK
 *
 * Módulo puro: sin efectos secundarios, sin acceso a DB. 100% testeable.
 */

import { RISK_WEIGHTS, ALLOW_THRESHOLD, DELAY_THRESHOLD, COOLDOWN_PROPORTIONAL_MULTIPLIER } from './rules'
import type {
  ContactFrequencyRule,
  ContactFrequencyProfile,
  FrequencyDecision,
} from './types'

// ── Config inyectable ─────────────────────────────────────────────────────────

/**
 * Config que puede sobreescribir los hardcoded de rules.ts.
 * Cuando se omite, calculateRiskScore usa los valores de rules.ts.
 * Esto permite inyectar valores desde DB (scoring_config) sin romper tests.
 */
export interface ScorerConfig {
  allowThreshold:     number
  delayThreshold:     number
  cooldownMultiplier: number
  weights:            { daily: number; weekly: number; cooldown: number }
}

const DEFAULT_SCORER_CONFIG: ScorerConfig = {
  allowThreshold:     ALLOW_THRESHOLD,
  delayThreshold:     DELAY_THRESHOLD,
  cooldownMultiplier: COOLDOWN_PROPORTIONAL_MULTIPLIER,
  weights:            { ...RISK_WEIGHTS },
}

// ── Tipo de resultado ─────────────────────────────────────────────────────────

/**
 * Resultado del calculateRiskScore().
 * Incluye el desglose de componentes para logging y debugging.
 */
export interface ScorerResult {
  decision:  FrequencyDecision
  riskScore: number
  reason:    string
  /**
   * Desglose de cómo se compuso el score.
   * Útil para diagnóstico: permite ver qué componente está elevando el riesgo.
   */
  components: {
    dailyScore:    number
    weeklyScore:   number
    cooldownScore: number
  }
}

// ── Función principal ─────────────────────────────────────────────────────────

/**
 * Calcula el Risk Score y la decisión de frecuencia para un contacto.
 *
 * Función pura: el resultado depende únicamente de profile, rule y cfg.
 * No hace IO, no tiene estado, es completamente determinista dado los inputs.
 *
 * @param profile - Perfil de frecuencia actual del contacto
 * @param rule    - Regla aplicable resuelta por resolveApplicableRule()
 * @param cfg     - Thresholds y pesos (opcional; usa hardcoded de rules.ts si se omite)
 */
export function calculateRiskScore(
  profile: ContactFrequencyProfile,
  rule:    ContactFrequencyRule,
  cfg:     ScorerConfig = DEFAULT_SCORER_CONFIG,
): ScorerResult {

  // ── Nivel 1: Bloqueos duros ───────────────────────────────────────────────
  // Evaluados en orden de restricción más estricta → menos estricta.
  // El primer bloqueo encontrado retorna inmediatamente.

  if (profile.sentToday >= rule.max_per_day) {
    return buildHardBlock(
      `Límite diario alcanzado: ${profile.sentToday}/${rule.max_per_day} mensajes en las últimas 24h`,
      profile, rule, cfg,
    )
  }

  if (profile.sentThisWeek >= rule.max_per_week) {
    return buildHardBlock(
      `Límite semanal alcanzado: ${profile.sentThisWeek}/${rule.max_per_week} mensajes en los últimos 7 días`,
      profile, rule, cfg,
    )
  }

  if (
    profile.hoursSinceLastSend !== null &&
    rule.min_hours_between_sends > 0 &&
    profile.hoursSinceLastSend < rule.min_hours_between_sends
  ) {
    const remainingHours = Math.ceil(rule.min_hours_between_sends - profile.hoursSinceLastSend)
    return buildHardBlock(
      `Cool-down activo: ${remainingHours}h restantes ` +
      `(mínimo ${rule.min_hours_between_sends}h entre envíos, ` +
      `último hace ${profile.hoursSinceLastSend.toFixed(1)}h)`,
      profile, rule, cfg,
    )
  }

  // ── Nivel 2: Score proporcional ───────────────────────────────────────────

  const dailyScore    = computeDailyScore(profile, rule, cfg.weights)
  const weeklyScore   = computeWeeklyScore(profile, rule, cfg.weights)
  const cooldownScore = computeCooldownScore(profile, rule, cfg)

  // Math.round evita scores como 13.000000000000002.
  // Math.min(100) previene overflow por imprecisión de punto flotante.
  const riskScore = Math.min(100, Math.round(dailyScore + weeklyScore + cooldownScore))
  const decision  = scoreToDecision(riskScore, cfg)
  const reason    = buildProportionalReason(decision, profile, rule, riskScore)

  return { decision, riskScore, reason, components: { dailyScore, weeklyScore, cooldownScore } }
}

// ── Componentes del score ─────────────────────────────────────────────────────

/**
 * Componente diario (0 → weights.daily).
 *
 * Sube linealmente a medida que el contacto se acerca al límite diario.
 * Nunca llega al máximo en el path proporcional: el bloqueo duro lo intercepta
 * cuando sentToday >= max_per_day (ratio = 1.0).
 */
function computeDailyScore(
  profile: ContactFrequencyProfile,
  rule:    ContactFrequencyRule,
  weights: ScorerConfig['weights'],
): number {
  if (rule.max_per_day <= 0) return 0
  const ratio = profile.sentToday / rule.max_per_day
  return weights.daily * clamp01(ratio)
}

/**
 * Componente semanal (0 → weights.weekly).
 *
 * Refleja cuánto de la "cuota semanal" se ha consumido.
 * Un contacto que ya recibió 1/2 mensajes esta semana tiene score semanal = weights.weekly / 2.
 */
function computeWeeklyScore(
  profile: ContactFrequencyProfile,
  rule:    ContactFrequencyRule,
  weights: ScorerConfig['weights'],
): number {
  if (rule.max_per_week <= 0) return 0
  const ratio = profile.sentThisWeek / rule.max_per_week
  return weights.weekly * clamp01(ratio)
}

/**
 * Componente cool-down (0 → weights.cooldown).
 *
 * ## Ventana ampliada (fix del bug "cooldown always 0")
 *
 * El path proporcional solo se alcanza cuando hoursSinceLastSend >= min_hours.
 * Con ventana = min_hours, ratio siempre sería >= 1 → score siempre 0.
 * Solución: usar ventana = min_hours × cooldownMultiplier (× 2 por defecto).
 *
 * Comportamiento con min_hours=48, multiplicador=2, ventana=96:
 *   hoursSinceLastSend=48h  → ratio=0.50 → pressure=0.50 → score=12.5  (límite cool-down)
 *   hoursSinceLastSend=96h  → ratio=1.00 → pressure=0.00 → score=0     (sin presión)
 *
 * Si nunca se envió (lastSentAt = null) → score = 0 (sin presión).
 */
function computeCooldownScore(
  profile: ContactFrequencyProfile,
  rule:    ContactFrequencyRule,
  cfg:     ScorerConfig,
): number {
  if (profile.hoursSinceLastSend === null || rule.min_hours_between_sends <= 0) return 0
  const proportionalWindow = rule.min_hours_between_sends * cfg.cooldownMultiplier
  const ratio              = profile.hoursSinceLastSend / proportionalWindow
  const inversePressure    = clamp01(1 - ratio)
  return cfg.weights.cooldown * inversePressure
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Construye un resultado de bloqueo duro (score = 100, BLOCK).
 * Incluye los scores proporcionales en `components` para diagnóstico,
 * aunque la decisión ya esté tomada.
 */
function buildHardBlock(
  reason:  string,
  profile: ContactFrequencyProfile,
  rule:    ContactFrequencyRule,
  cfg:     ScorerConfig,
): ScorerResult {
  return {
    decision:  'BLOCK',
    riskScore: 100,
    reason,
    components: {
      dailyScore:    computeDailyScore(profile, rule, cfg.weights),
      weeklyScore:   computeWeeklyScore(profile, rule, cfg.weights),
      cooldownScore: computeCooldownScore(profile, rule, cfg),
    },
  }
}

/** Convierte un score numérico a la decisión correspondiente. */
function scoreToDecision(score: number, cfg: ScorerConfig): FrequencyDecision {
  if (score <= cfg.allowThreshold) return 'ALLOW'
  if (score <= cfg.delayThreshold) return 'DELAY'
  return 'BLOCK'
}

/** Construye el mensaje de razón para el path proporcional (sin bloqueo duro). */
function buildProportionalReason(
  decision: FrequencyDecision,
  profile:  ContactFrequencyProfile,
  rule:     ContactFrequencyRule,
  score:    number,
): string {
  const dayStr  = `${profile.sentToday}/${rule.max_per_day} hoy`
  const weekStr = `${profile.sentThisWeek}/${rule.max_per_week} esta semana`
  const lastStr = profile.hoursSinceLastSend !== null
    ? `último envío hace ${profile.hoursSinceLastSend.toFixed(1)}h`
    : 'primer envío a este contacto'

  switch (decision) {
    case 'ALLOW':
      return `Score ${score} — dentro de límites (${dayStr}, ${weekStr}, ${lastStr})`
    case 'DELAY':
      return `Score ${score} — riesgo moderado, recomendado esperar (${dayStr}, ${weekStr}, ${lastStr})`
    case 'BLOCK':
      return `Score ${score} — envío bloqueado por política de frecuencia (${dayStr}, ${weekStr}, ${lastStr})`
  }
}

/** Clampea un número al rango [0, 1]. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
