import {
  VALUE_SCORES,
  INACTIVITY_WINDOWS,
  REACTIVATION_SEGMENT_RULES,
  DEPOSIT_AMOUNT_TIERS,
} from './config'
import type { ValueTier, ReactivationSegment } from './config'

export interface ScoreBreakdown {
  valueScore:          number                    // 0–60: LTV del tier
  urgencyScore:        number                    // 0–40: posición en ventana del tier
  total:               number                    // 0–100
  valueTier:           ValueTier
  reactivationSegment: ReactivationSegment | null
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
  segment: string | null,
  totalDepositAmount: number | null,
): ValueTier {
  if (totalDepositAmount !== null) {
    for (const { minAmount, tier } of DEPOSIT_AMOUNT_TIERS) {
      if (totalDepositAmount >= minAmount) return tier
    }
  }

  switch (segment) {
    case 'vip':   return 'vip'
    case 'alto':  return 'alto'
    case 'medio': return 'medio'
    default:      return 'bajo'
  }
}

// ── Componentes del score ─────────────────────────────────────────────────────

/**
 * Score de valor (0–60).
 * Constante por tier — el valor del contacto no cambia con el tiempo,
 * solo cambia su urgencia de reactivación.
 */
export function scoreValue(tier: ValueTier): number {
  return VALUE_SCORES[tier]
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
export function scoreUrgency(daysInactive: number, tier: ValueTier): number {
  const { minDays, maxDays } = INACTIVITY_WINDOWS[tier]
  const span = maxDays - minDays
  if (span <= 0) return 0

  const position = Math.min(1, (daysInactive - minDays) / span)
  return Math.max(0, Math.round((1 - position) * 40))
}

/**
 * Clasifica al contacto en un segmento de difusión.
 * Aplica el primer match de REACTIVATION_SEGMENT_RULES (reglas ordenadas por prioridad).
 * Retorna null si el contacto está fuera de todas las ventanas conocidas.
 */
export function resolveReactivationSegment(
  tier: ValueTier,
  daysInactive: number,
): ReactivationSegment | null {
  for (const rule of REACTIVATION_SEGMENT_RULES) {
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

export function computeScore(metrics: {
  daysInactive:       number
  segment:            string | null
  totalDepositAmount: number | null
}): ScoreBreakdown {
  const tier    = resolveValueTier(metrics.segment, metrics.totalDepositAmount)
  const vScore  = scoreValue(tier)
  const uScore  = scoreUrgency(metrics.daysInactive, tier)
  const segment = resolveReactivationSegment(tier, metrics.daysInactive)

  return {
    valueScore:          vScore,
    urgencyScore:        uScore,
    total:               vScore + uScore,
    valueTier:           tier,
    reactivationSegment: segment,
  }
}
