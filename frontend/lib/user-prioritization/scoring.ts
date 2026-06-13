import {
  VALUE_SCORES,
  INACTIVITY_WINDOWS,
  REACTIVATION_SEGMENT_RULES,
  DEPOSIT_AMOUNT_TIERS,
} from './config'
import type { ValueTier, ReactivationSegment, InactivityWindow, SegmentRule } from './config'

export interface ScoreBreakdown {
  valueScore:          number                    // 0–60: LTV del tier
  urgencyScore:        number                    // 0–40: posición en ventana del tier
  total:               number                    // 0–100
  valueTier:           ValueTier
  reactivationSegment: ReactivationSegment | null
}

/**
 * Config que puede sobreescribir los hardcoded de config.ts.
 * Cuando se omite, las funciones usan los valores de config.ts.
 * Esto permite inyectar valores desde DB sin romper tests ni callers existentes.
 */
export interface ScoringConfig {
  valueScores:              Record<ValueTier, number>
  inactivityWindows:        Record<ValueTier, InactivityWindow>
  depositAmountTiers:       Array<{ minAmount: number; tier: ValueTier }>
  reactivationSegmentRules: SegmentRule[]
}

const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  valueScores:              VALUE_SCORES,
  inactivityWindows:        INACTIVITY_WINDOWS,
  depositAmountTiers:       DEPOSIT_AMOUNT_TIERS,
  reactivationSegmentRules: REACTIVATION_SEGMENT_RULES,
}

// ── Resolución de tier ────────────────────────────────────────────────────────

/**
 * Resuelve el tier de valor del contacto.
 *
 * Prioridad:
 *   1. total_deposit_amount (más preciso, refleja valor monetario real)
 *   2. segment declarado (proxy calculado por el casino)
 *   3. Fallback a 'bajo' (desconocido, conservador)
 *
 * El parámetro amount está preparado para cuando esté disponible en DB.
 * Mientras sea NULL se usa el segment, que ya es una clasificación de valor
 * computada por el sistema del casino.
 */
export function resolveValueTier(
  segment:            string | null,
  totalDepositAmount: number | null,
  depositAmountTiers: Array<{ minAmount: number; tier: ValueTier }> = DEPOSIT_AMOUNT_TIERS,
): ValueTier {
  if (totalDepositAmount !== null) {
    for (const { minAmount, tier } of depositAmountTiers) {
      if (totalDepositAmount >= minAmount) return tier
    }
  }

  switch (segment) {
    case 'super_vip': return 'super_vip'
    case 'vip_alto':  return 'vip_alto'
    case 'vip_medio': return 'vip_medio'
    case 'vip':       return 'vip'
    case 'medio':     return 'medio'
    default:          return 'bajo'
  }
}

// ── Componentes del score ─────────────────────────────────────────────────────

/**
 * Score de valor (0–60).
 * Constante por tier — el valor del contacto no cambia con el tiempo,
 * solo cambia su urgencia de reactivación.
 */
export function scoreValue(tier: ValueTier, cfg: ScoringConfig = DEFAULT_SCORING_CONFIG): number {
  return cfg.valueScores[tier]
}

/**
 * Score de urgencia (0–40).
 *
 * Decae linealmente desde 40 (inicio de ventana) hasta 0 (fin de ventana).
 * Dentro de un mismo segmento de difusión, siempre priorizamos contactar
 * antes a los más recientemente inactivos: mayor memoria de la marca,
 * mayor probabilidad de retorno con el mismo costo de mensaje.
 *
 * Ejemplo con tier VIP (ventana 7–120 días):
 *   7 días  → position=0.00 → urgency=40  (acaba de dejar de depositar)
 *   63 días → position=0.50 → urgency=20  (mitad de ventana)
 *   120 días → position=1.00 → urgency=0  (al límite)
 */
export function scoreUrgency(daysInactive: number, tier: ValueTier, cfg: ScoringConfig = DEFAULT_SCORING_CONFIG): number {
  const { minDays, maxDays } = cfg.inactivityWindows[tier]
  const span = maxDays - minDays
  if (span <= 0) return 0

  const position = Math.min(1, (daysInactive - minDays) / span)
  return Math.max(0, Math.round((1 - position) * 40))
}

/**
 * Clasifica al contacto en un segmento de difusión.
 * Aplica el primer match de reactivationSegmentRules (reglas ordenadas por prioridad).
 * Retorna null si el contacto está fuera de todas las ventanas conocidas.
 */
export function resolveReactivationSegment(
  tier:         ValueTier,
  daysInactive: number,
  cfg:          ScoringConfig = DEFAULT_SCORING_CONFIG,
): ReactivationSegment | null {
  for (const rule of cfg.reactivationSegmentRules) {
    if (
      rule.tiers.includes(tier) &&
      daysInactive >= rule.minDays &&
      daysInactive <= rule.maxDays
    ) {
      return rule.segment
    }
  }
  return null
}

// ── Cómputo unificado ─────────────────────────────────────────────────────────

export function computeScore(
  metrics: {
    daysInactive:       number
    segment:            string | null
    totalDepositAmount: number | null
    // LTV dinámico: cuando están presentes reemplazan el tier/score plano del tier.
    // Si son null/undefined el comportamiento es idéntico al de antes (backward compat).
    ltvScore?:          number | null
    ltvTier?:           ValueTier | null
  },
  cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
): ScoreBreakdown {
  // Tier: priorizar ltvTier (basado en percentil real) sobre el fallback de monto/segmento.
  // El tier determina la ventana de inactividad para urgency_score.
  const tier = metrics.ltvTier
    ?? resolveValueTier(metrics.segment, metrics.totalDepositAmount, cfg.depositAmountTiers)

  // Value score: priorizar ltvScore dinámico (0–60 continuo) sobre el constante del tier.
  const vScore = (metrics.ltvScore != null)
    ? metrics.ltvScore
    : scoreValue(tier, cfg)

  const uScore  = scoreUrgency(metrics.daysInactive, tier, cfg)
  const segment = resolveReactivationSegment(tier, metrics.daysInactive, cfg)

  return {
    valueScore:          vScore,
    urgencyScore:        uScore,
    total:               vScore + uScore,
    valueTier:           tier,
    reactivationSegment: segment,
  }
}
