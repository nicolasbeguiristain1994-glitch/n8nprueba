/**
 * WarmingOrchestratorService
 *
 * Orquesta el calentamiento diario entre múltiples líneas activas.
 * Servicio puro: no accede a la DB ni al reloj del sistema.
 *
 * Responsabilidades:
 *  - orchestrate(): calcula salud + cuota de cada línea y asigna pesos proporcionales
 *  - computeLineWeight(): peso normalizado de una línea en el pool activo
 *  - calculateTrend(): dirección e intensidad del cambio de salud en el historial
 *  - summarizeHistory(): estadísticas descriptivas de un historial de scores
 */

import {
  healthCalculatorService,
  HealthCalculatorService,
  type HealthResult,
  type HealthComponents,
  type DailyStats,
} from './health-calculator.service'

import {
  dailyQuotaCalculatorService,
  DailyQuotaCalculatorService,
  type ScheduleResult,
} from './daily-quota-calculator.service'

import type { DelayPreset } from '@/lib/warmup-engine'

// ── Tipos públicos ────────────────────────────────────────────────────────────

export interface OrchestratorLineInput {
  id:                   string
  warmup_status:        'active' | 'paused' | 'completed' | 'banned'
  current_day:          number
  target_days:          number
  /** Pre-calculado por el caller via getDailyLimitForDay(current_day, target_days). */
  effectiveDailyLimit:  number
  messages_sent_today:  number
  /** Días desde el último mensaje. 0 = sin historial o actividad reciente. */
  daysSinceLastMessage: number
  delay_preset:         DelayPreset
  recent7days:          DailyStats[]
}

export interface LineOrchestrationResult {
  lineId:    string
  health:    HealthResult
  schedule:  ScheduleResult
  /** Fracción del quota total asignada a esta línea (0-1). 0 si no envía hoy. */
  weight:    number
}

export interface OrchestrationResult {
  lines:               LineOrchestrationResult[]
  totalActiveLines:    number
  totalDailyQuota:     number
  totalRemainingToday: number
  orchestratedAt:      string
}

export interface HealthHistoryPoint {
  recordedAt:   string
  score:        number
  components:   HealthComponents
  dailyQuota:   number
  messagesSent: number
}

export type TrendDirection = 'improving' | 'declining' | 'stable'

export interface TrendResult {
  direction:    TrendDirection
  /** Diferencia entre el score más reciente y el más antiguo del historial. */
  delta:        number
  averageScore: number
  minScore:     number
  maxScore:     number
}

export interface HistorySummary {
  totalPoints:  number
  averageScore: number
  minScore:     number
  maxScore:     number
  trend:        TrendResult
  /** Score más reciente disponible. -1 si no hay historial. */
  latestScore:  number
}

export interface OrchestratorDeps {
  healthCalculator?: HealthCalculatorService
  quotaCalculator?:  DailyQuotaCalculatorService
}

// ── Constantes ────────────────────────────────────────────────────────────────

/** Diferencia mínima de score para considerar una tendencia como "improving" o "declining". */
const TREND_THRESHOLD = 5

// ── Servicio ──────────────────────────────────────────────────────────────────

export class WarmingOrchestratorService {
  private readonly healthCalc:  HealthCalculatorService
  private readonly quotaCalc:   DailyQuotaCalculatorService

  constructor(deps: OrchestratorDeps = {}) {
    this.healthCalc = deps.healthCalculator ?? healthCalculatorService
    this.quotaCalc  = deps.quotaCalculator  ?? dailyQuotaCalculatorService
  }

  /**
   * Calcula salud y cuota para todas las líneas y asigna pesos proporcionales
   * entre las que deben enviar hoy.
   */
  orchestrate(lines: OrchestratorLineInput[]): OrchestrationResult {
    const results: LineOrchestrationResult[] = lines.map(line => {
      const health   = this.healthCalc.calculate({
        warmup_status:        line.warmup_status,
        current_day:          line.current_day,
        target_days:          line.target_days,
        effectiveDailyLimit:  line.effectiveDailyLimit,
        messages_sent_today:  line.messages_sent_today,
        daysSinceLastMessage: line.daysSinceLastMessage,
        recent7days:          line.recent7days,
      })

      const schedule = this.quotaCalc.getDailyQuota({
        current_day:         line.current_day,
        target_days:         line.target_days,
        health_score:        health.score,
        delay_preset:        line.delay_preset,
        warmup_status:       line.warmup_status,
        messages_sent_today: line.messages_sent_today,
      })

      return { lineId: line.id, health, schedule, weight: 0 }
    })

    // Peso proporcional al health score entre líneas que envían hoy
    const totalActiveHealthScore = results
      .filter(r => r.schedule.shouldSendToday)
      .reduce((sum, r) => sum + r.health.score, 0)

    for (const r of results) {
      r.weight = this.computeLineWeight(
        r.health.score,
        r.schedule.shouldSendToday,
        totalActiveHealthScore,
      )
    }

    const totalDailyQuota     = results.reduce((s, r) => s + r.schedule.dailyQuota,     0)
    const totalRemainingToday = results.reduce((s, r) => s + r.schedule.remainingToday, 0)
    const totalActiveLines    = results.filter(r => r.schedule.shouldSendToday).length

    return {
      lines: results,
      totalActiveLines,
      totalDailyQuota,
      totalRemainingToday,
      orchestratedAt: new Date().toISOString(),
    }
  }

  /**
   * Peso normalizado de una línea en el pool activo.
   * Devuelve 0 si la línea no envía hoy o el pool activo tiene score total 0.
   */
  computeLineWeight(
    healthScore:           number,
    shouldSendToday:       boolean,
    totalActiveHealthScore: number,
  ): number {
    if (!shouldSendToday || totalActiveHealthScore === 0) return 0
    return healthScore / totalActiveHealthScore
  }

  /**
   * Analiza la dirección del cambio de salud en el historial.
   * Requiere al menos 2 puntos; con 0-1 devuelve 'stable' con delta 0.
   */
  calculateTrend(history: HealthHistoryPoint[]): TrendResult {
    if (history.length < 2) {
      const single = history[0]?.score ?? 0
      return {
        direction:    'stable',
        delta:        0,
        averageScore: single,
        minScore:     single,
        maxScore:     single,
      }
    }

    const scores     = history.map(h => h.score)
    const oldest     = scores[scores.length - 1]
    const newest     = scores[0]
    const delta      = newest - oldest
    const avgScore   = Math.round(scores.reduce((s, v) => s + v, 0) / scores.length)
    const minScore   = Math.min(...scores)
    const maxScore   = Math.max(...scores)

    let direction: TrendDirection = 'stable'
    if (delta >= TREND_THRESHOLD)       direction = 'improving'
    else if (delta <= -TREND_THRESHOLD) direction = 'declining'

    return { direction, delta, averageScore: avgScore, minScore, maxScore }
  }

  /** Estadísticas descriptivas completas de un historial. */
  summarizeHistory(history: HealthHistoryPoint[]): HistorySummary {
    if (history.length === 0) {
      return {
        totalPoints:  0,
        averageScore: 0,
        minScore:     0,
        maxScore:     0,
        trend:        { direction: 'stable', delta: 0, averageScore: 0, minScore: 0, maxScore: 0 },
        latestScore:  -1,
      }
    }

    const scores     = history.map(h => h.score)
    const avgScore   = Math.round(scores.reduce((s, v) => s + v, 0) / scores.length)
    const minScore   = Math.min(...scores)
    const maxScore   = Math.max(...scores)
    const trend      = this.calculateTrend(history)

    return {
      totalPoints:  history.length,
      averageScore: avgScore,
      minScore,
      maxScore,
      trend,
      latestScore:  scores[0],
    }
  }
}

export const warmingOrchestratorService = new WarmingOrchestratorService()
