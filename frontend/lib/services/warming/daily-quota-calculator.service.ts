/**
 * DailyQuotaCalculatorService  (renombrado desde WarmingSchedulerService v1)
 *
 * Calcula la cuota diaria recomendada y determina si una línea de
 * calentamiento debe enviar mensajes en la jornada actual.
 *
 * cuotaFinal = round(base × factorSalud × factorEstrategia), mínimo 1.
 *
 * Umbrales de salud:
 *   ≥ 80  → ×1.00  Cuota completa
 *   ≥ 60  → ×0.90  Reducción leve (−10 %)
 *   ≥ 40  → ×0.75  Reducción moderada (−25 %)
 *   ≥ 20  → ×0.50  Cuota reducida a la mitad
 *   <  20 → ×0.25  Modo emergencia (−75 %)
 *
 * Los factores de estrategia son configurables via constructor.
 */

import { getDailyLimitForDay } from '@/lib/warmup-engine'
import type { DelayPreset } from '@/lib/warmup-engine'

// ── Tipos públicos ────────────────────────────────────────────────────────────

export interface ScheduleInput {
  current_day:         number
  target_days:         number
  health_score:        number
  delay_preset:        DelayPreset
  warmup_status:       string
  messages_sent_today: number
}

export interface QuotaAdjustment {
  factor: number
  reason: string
}

export interface ScheduleResult {
  /** Cuota diaria calculada tras aplicar factores de salud y estrategia. */
  dailyQuota:         number
  /** Alias explícito de dailyQuota para consumo directo en UI. */
  assignedQuotaToday: number
  remainingToday:     number
  shouldSendToday:    boolean
  baseQuota:          number
  adjustment:         QuotaAdjustment
  strategyFactor:     number
  phaseLabel:         string
}

export interface QuotaCalculatorConfig {
  /** Factores de estrategia personalizados. Sobreescribe los valores por defecto. */
  strategyFactors?: Partial<Record<DelayPreset, number>>
}

// ── Constantes por defecto ────────────────────────────────────────────────────

const DEFAULT_HEALTH_ADJUSTMENTS: ReadonlyArray<{ min: number; factor: number; reason: string }> = [
  { min: 80, factor: 1.00, reason: 'Salud óptima — cuota completa' },
  { min: 60, factor: 0.90, reason: 'Salud buena — reducción leve (−10 %)' },
  { min: 40, factor: 0.75, reason: 'Salud regular — reducción moderada (−25 %)' },
  { min: 20, factor: 0.50, reason: 'Salud baja — cuota reducida a la mitad' },
  { min:  0, factor: 0.25, reason: 'Salud crítica — modo emergencia (−75 %)' },
]

const DEFAULT_STRATEGY_FACTORS: Record<DelayPreset, number> = {
  conservadora: 0.70,
  normal:       1.00,
  agresiva:     1.30,
}

// ── Servicio ──────────────────────────────────────────────────────────────────

export class DailyQuotaCalculatorService {
  private readonly strategyFactors: Record<DelayPreset, number>

  constructor(config: QuotaCalculatorConfig = {}) {
    this.strategyFactors = { ...DEFAULT_STRATEGY_FACTORS, ...config.strategyFactors }
  }

  getDailyQuota(input: ScheduleInput): ScheduleResult {
    if (input.warmup_status !== 'active') return this.inactiveResult(input)

    const baseQuota      = getDailyLimitForDay(input.current_day, input.target_days)
    const adjustment     = this.resolveHealthAdjustment(input.health_score)
    const strategyFactor = this.strategyFactors[input.delay_preset] ?? 1.0
    const dailyQuota     = Math.max(1, Math.round(baseQuota * adjustment.factor * strategyFactor))
    const remainingToday = Math.max(0, dailyQuota - input.messages_sent_today)

    return {
      dailyQuota,
      assignedQuotaToday: dailyQuota,
      remainingToday,
      shouldSendToday: remainingToday > 0,
      baseQuota,
      adjustment,
      strategyFactor,
      phaseLabel: this.phaseLabel(input.current_day),
    }
  }

  private resolveHealthAdjustment(healthScore: number): QuotaAdjustment {
    for (const threshold of DEFAULT_HEALTH_ADJUSTMENTS) {
      if (healthScore >= threshold.min) {
        return { factor: threshold.factor, reason: threshold.reason }
      }
    }
    return { factor: 0.25, reason: 'Salud crítica — modo emergencia (−75 %)' }
  }

  phaseLabel(currentDay: number): string {
    if (currentDay <= 7)  return 'Fase 1: Fundación (Día 1–7)'
    if (currentDay <= 14) return 'Fase 2: Crecimiento (Día 8–14)'
    return 'Fase 3: Maduración (Día 15+)'
  }

  private inactiveResult(input: ScheduleInput): ScheduleResult {
    return {
      dailyQuota:         0,
      assignedQuotaToday: 0,
      remainingToday:     0,
      shouldSendToday:    false,
      baseQuota:          getDailyLimitForDay(input.current_day, input.target_days),
      adjustment:         { factor: 0, reason: `Línea ${input.warmup_status} — no envía` },
      strategyFactor:     this.strategyFactors[input.delay_preset] ?? 1.0,
      phaseLabel:         this.phaseLabel(input.current_day),
    }
  }
}

export const dailyQuotaCalculatorService = new DailyQuotaCalculatorService()

// ── Backward-compat — mantener hasta migrar todos los consumidores ────────────

/** @deprecated Usar DailyQuotaCalculatorService */
export { DailyQuotaCalculatorService as WarmingSchedulerService }
/** @deprecated Usar dailyQuotaCalculatorService */
export const warmingSchedulerService = dailyQuotaCalculatorService
