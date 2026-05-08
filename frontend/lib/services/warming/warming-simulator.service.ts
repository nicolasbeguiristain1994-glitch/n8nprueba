/**
 * WarmingSimulatorService
 *
 * Simulador "what-if" para el módulo de calentamiento.
 * Servicio puro: todos los inputs son pre-calculados por el caller.
 *
 * Escenarios soportados:
 *   add_lines       — ¿Qué pasa si agrego N líneas con estrategia X?
 *   change_strategy — ¿Qué pasa si cambio líneas existentes a estrategia X?
 *   project_health  — ¿Cómo evolucionará la salud en N días?
 */

import { getDailyLimitForDay } from '@/lib/warmup-engine'
import type { DelayPreset } from '@/lib/warmup-engine'

// ── Tipos públicos ────────────────────────────────────────────────────────────

export type SimulationScenario = 'add_lines' | 'change_strategy' | 'project_health'

export interface SimulatorLineInput {
  id:                  string
  warmup_status:       string
  current_day:         number
  target_days:         number
  health_score:        number
  delay_preset:        DelayPreset
  messages_sent_today: number
  /**
   * Delta de salud del historial reciente (últimos N snapshots).
   * Positivo = mejorando. Negativo = empeorando. 0 = sin historial.
   */
  trendDelta:          number
}

export interface SimulatorInput {
  scenario:     SimulationScenario
  currentLines: SimulatorLineInput[]

  // ── add_lines ──────────────────────────────────────────
  newLinesCount?:      number
  newLinesStrategy?:   DelayPreset
  newLinesTargetDays?: number

  // ── change_strategy ────────────────────────────────────
  targetStrategy?: DelayPreset
  /** IDs de líneas a cambiar. Si está vacío/undefined → todas las activas. */
  lineIds?:        string[]

  // ── project_health ─────────────────────────────────────
  /** Días de proyección. Rango 1-30. */
  projectionDays?: number
}

export interface LineProjection {
  lineId:               string
  currentHealthScore:   number
  projectedHealthScore: number
  currentDailyQuota:    number
  projectedDailyQuota:  number
  /** null si ya está completada o no es activa. */
  daysToCompletion:     number | null
  isLikelyToComplete:   boolean
  changeNote:           string
}

export interface SimulationTotals {
  currentQuota:    number
  projectedQuota:  number
  quotaChange:     number
  /** Porcentaje de cambio vs. cuota actual. */
  quotaChangePct:  number
}

export interface SimulationInsights {
  avgProjectedHealth:      number
  estimatedNewActiveLines: number
  riskLevel:               'low' | 'medium' | 'high'
  riskDetails:             string
  recommendation:          string
}

export interface SimulationResult {
  scenario:     SimulationScenario
  inputSummary: string
  projections:  LineProjection[]
  totals:       SimulationTotals
  insights:     SimulationInsights
}

// ── Factores (espejean DailyQuotaCalculatorService) ──────────────────────────

const STRATEGY_FACTORS: Record<DelayPreset, number> = {
  conservadora: 0.70,
  normal:       1.00,
  agresiva:     1.30,
}

function healthFactor(score: number): number {
  if (score >= 80) return 1.00
  if (score >= 60) return 0.90
  if (score >= 40) return 0.75
  if (score >= 20) return 0.50
  return 0.25
}

// ── Score inicial estimado para una línea nueva (día 1) ───────────────────────
const NEW_LINE_INITIAL_SCORE = 40

// ── Servicio ──────────────────────────────────────────────────────────────────

export class WarmingSimulatorService {
  simulate(input: SimulatorInput): SimulationResult {
    switch (input.scenario) {
      case 'add_lines':       return this.simulateAddLines(input)
      case 'change_strategy': return this.simulateChangeStrategy(input)
      case 'project_health':  return this.simulateProjectHealth(input)
    }
  }

  // ── Escenarios ──────────────────────────────────────────────────────────────

  private simulateAddLines(input: SimulatorInput): SimulationResult {
    const count      = Math.max(1, input.newLinesCount ?? 1)
    const strategy   = input.newLinesStrategy  ?? 'normal'
    const targetDays = input.newLinesTargetDays ?? 21

    const currentQuota = this.totalActiveQuota(input.currentLines)

    const projections: LineProjection[] = Array.from({ length: count }, (_, i) => {
      const quota = this.quota(1, targetDays, NEW_LINE_INITIAL_SCORE, strategy)
      return {
        lineId:               `nueva-línea-${i + 1}`,
        currentHealthScore:   0,
        projectedHealthScore: NEW_LINE_INITIAL_SCORE,
        currentDailyQuota:    0,
        projectedDailyQuota:  quota,
        daysToCompletion:     targetDays,
        isLikelyToComplete:   true,
        changeNote:           `Nueva · estrategia ${strategy} · objetivo ${targetDays} días`,
      }
    })

    const addedQuota     = projections.reduce((s, p) => s + p.projectedDailyQuota, 0)
    const projectedQuota = currentQuota + addedQuota
    const quotaChangePct = currentQuota > 0 ? Math.round((addedQuota / currentQuota) * 100) : 100

    const riskLevel: SimulationInsights['riskLevel'] =
      strategy === 'agresiva' && count > 5 ? 'high'
      : strategy === 'agresiva' || count > 10 ? 'medium'
      : 'low'

    return {
      scenario: 'add_lines',
      inputSummary: `Agregar ${count} línea${count > 1 ? 's' : ''} · estrategia "${strategy}" · ${targetDays} días objetivo`,
      projections,
      totals: { currentQuota, projectedQuota, quotaChange: addedQuota, quotaChangePct },
      insights: {
        avgProjectedHealth:      NEW_LINE_INITIAL_SCORE,
        estimatedNewActiveLines: count,
        riskLevel,
        riskDetails: riskLevel === 'high'
          ? 'Muchas líneas agresivas simultáneas pueden saturar el pool y disparar detección de spam.'
          : riskLevel === 'medium'
          ? 'Monitorear de cerca las nuevas líneas durante los primeros 7 días.'
          : 'Incorporación gradual y controlada — riesgo bajo.',
        recommendation: `Cuota adicional: +${addedQuota} msgs/día (+${quotaChangePct}% sobre el total actual de ${currentQuota})`,
      },
    }
  }

  private simulateChangeStrategy(input: SimulatorInput): SimulationResult {
    const newStrategy = input.targetStrategy ?? 'normal'
    const targetSet   = new Set(input.lineIds ?? [])
    const applyToAll  = targetSet.size === 0

    const activeLines  = input.currentLines.filter(l => l.warmup_status === 'active' || l.warmup_status === 'paused')
    const currentQuota = this.totalActiveQuota(input.currentLines)

    const projections: LineProjection[] = activeLines.map(line => {
      const affected = applyToAll || targetSet.has(line.id)
      const strategy = affected ? newStrategy : line.delay_preset

      const currentQ   = this.quota(line.current_day, line.target_days, line.health_score, line.delay_preset)
      const projectedQ = this.quota(line.current_day, line.target_days, line.health_score, strategy)

      return {
        lineId:               line.id,
        currentHealthScore:   line.health_score,
        projectedHealthScore: line.health_score,
        currentDailyQuota:    currentQ,
        projectedDailyQuota:  projectedQ,
        daysToCompletion:     Math.max(0, line.target_days - line.current_day),
        isLikelyToComplete:   line.health_score >= 40,
        changeNote:           affected ? `${line.delay_preset} → ${newStrategy}` : 'Sin cambio',
      }
    })

    const projectedQuota = projections.reduce((s, p) => s + p.projectedDailyQuota, 0)
    const quotaChange    = projectedQuota - currentQuota
    const quotaChangePct = currentQuota > 0 ? Math.round((quotaChange / currentQuota) * 100) : 0
    const avgHealth      = projections.length > 0
      ? Math.round(projections.reduce((s, p) => s + p.projectedHealthScore, 0) / projections.length)
      : 0

    const riskLevel: SimulationInsights['riskLevel'] = newStrategy === 'agresiva' ? 'medium' : 'low'

    return {
      scenario: 'change_strategy',
      inputSummary: `Cambiar a estrategia "${newStrategy}" ${applyToAll ? 'en todas las líneas activas' : `en ${targetSet.size} líneas seleccionadas`}`,
      projections,
      totals: { currentQuota, projectedQuota, quotaChange, quotaChangePct },
      insights: {
        avgProjectedHealth:      avgHealth,
        estimatedNewActiveLines: 0,
        riskLevel,
        riskDetails: newStrategy === 'agresiva'
          ? 'Mayor throughput pero mayor exposición al detectores de spam de WhatsApp.'
          : newStrategy === 'conservadora'
          ? 'Menor riesgo de ban a costa de más tiempo hasta completar el calentamiento.'
          : 'Balance óptimo entre velocidad y seguridad.',
        recommendation: quotaChange >= 0
          ? `La cuota total aumenta ${quotaChange} msgs/día (+${quotaChangePct}%)`
          : `La cuota total baja ${Math.abs(quotaChange)} msgs/día (${quotaChangePct}%)`,
      },
    }
  }

  private simulateProjectHealth(input: SimulatorInput): SimulationResult {
    const days = Math.max(1, Math.min(30, input.projectionDays ?? 14))
    const activeLines  = input.currentLines.filter(l => l.warmup_status === 'active')
    const currentQuota = this.totalActiveQuota(input.currentLines)

    const projections: LineProjection[] = activeLines.map(line => {
      // Extrapolación lineal del trendDelta (asumido sobre ~7 días de historial)
      const dailyTrend     = line.trendDelta / 7
      const projectedScore = Math.max(0, Math.min(100, Math.round(line.health_score + dailyTrend * days)))
      const projectedDay   = Math.min(line.current_day + days, line.target_days)

      const currentQ   = this.quota(line.current_day, line.target_days, line.health_score, line.delay_preset)
      const projectedQ = this.quota(projectedDay, line.target_days, projectedScore, line.delay_preset)

      const remaining  = Math.max(0, line.target_days - line.current_day)

      return {
        lineId:               line.id,
        currentHealthScore:   line.health_score,
        projectedHealthScore: projectedScore,
        currentDailyQuota:    currentQ,
        projectedDailyQuota:  projectedQ,
        daysToCompletion:     remaining,
        isLikelyToComplete:   projectedScore >= 40 && remaining <= days,
        changeNote:           `Día ${line.current_day}→${projectedDay} · salud ${line.health_score}→${projectedScore}`,
      }
    })

    const projectedQuota = projections.reduce((s, p) => s + p.projectedDailyQuota, 0)
    const quotaChange    = projectedQuota - currentQuota
    const quotaChangePct = currentQuota > 0 ? Math.round((quotaChange / currentQuota) * 100) : 0
    const avgHealth      = projections.length > 0
      ? Math.round(projections.reduce((s, p) => s + p.projectedHealthScore, 0) / projections.length)
      : 0

    const criticals  = projections.filter(p => p.projectedHealthScore < 30).length
    const riskLevel: SimulationInsights['riskLevel'] =
      criticals > projections.length * 0.3 ? 'high'
      : criticals > 0 ? 'medium'
      : 'low'

    return {
      scenario: 'project_health',
      inputSummary: `Proyección a ${days} días con estrategias actuales`,
      projections,
      totals: { currentQuota, projectedQuota, quotaChange, quotaChangePct },
      insights: {
        avgProjectedHealth:      avgHealth,
        estimatedNewActiveLines: projections.filter(p => p.isLikelyToComplete).length,
        riskLevel,
        riskDetails: criticals > 0
          ? `${criticals} línea${criticals > 1 ? 's' : ''} con salud proyectada crítica (<30) en ${days} días`
          : 'Todas las líneas proyectan salud aceptable en el período.',
        recommendation: `Salud promedio proyectada: ${avgHealth}/100 en ${days} días`,
      },
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Calcula cuota diaria dado día, objetivo, salud y estrategia. */
  quota(currentDay: number, targetDays: number, healthScore: number, strategy: DelayPreset): number {
    const base    = getDailyLimitForDay(currentDay, targetDays)
    const hFactor = healthFactor(healthScore)
    const sFactor = STRATEGY_FACTORS[strategy] ?? 1.0
    return Math.max(1, Math.round(base * hFactor * sFactor))
  }

  private totalActiveQuota(lines: SimulatorLineInput[]): number {
    return lines
      .filter(l => l.warmup_status === 'active')
      .reduce((s, l) => s + this.quota(l.current_day, l.target_days, l.health_score, l.delay_preset), 0)
  }
}

export const warmingSimulatorService = new WarmingSimulatorService()
