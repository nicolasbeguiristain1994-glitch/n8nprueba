/**
 * WarmingEffectivenessService
 *
 * Calcula métricas de efectividad del módulo de calentamiento sobre el
 * estado actual del pool de líneas. Servicio puro: no accede a la DB.
 *
 * Métricas principales:
 *   - Tasa de éxito global (completed / [completed + banned])
 *   - Ratio de completados (completed / total)
 *   - Tasa de ban (banned / total)
 *   - Desglose por estrategia (conservadora / normal / agresiva)
 *   - Estrategia con mejor desempeño
 */

import type { DelayPreset } from '@/lib/warmup-engine'

// ── Tipos públicos ────────────────────────────────────────────────────────────

export interface EffectivenessLineInput {
  id:            string
  warmup_status: 'active' | 'paused' | 'completed' | 'banned'
  current_day:   number
  target_days:   number
  delay_preset:  DelayPreset
  health_score:  number
}

export interface StrategyMetrics {
  preset:           DelayPreset
  totalLines:       number
  activeLines:      number
  pausedLines:      number
  completedLines:   number
  bannedLines:      number
  /** Entre estados terminales: completed / (completed + banned) × 100 */
  successRate:      number
  /** completed / total × 100 */
  completionRatio:  number
  avgCurrentDay:    number
  avgHealthScore:   number
}

export interface EffectivenessReport {
  totalLines:            number
  activeLines:           number
  pausedLines:           number
  completedLines:        number
  bannedLines:           number
  /** Entre líneas en estado terminal (completed o banned). */
  overallSuccessRate:    number
  /** completed / total × 100 */
  completionRatio:       number
  /** banned / total × 100 */
  banRate:               number
  byStrategy:            StrategyMetrics[]
  /** Preset con mayor successRate (tiebreak: más completadas). null si ninguna ha terminado. */
  topPerformingStrategy: DelayPreset | null
  generatedAt:           string
}

// ── Constantes ────────────────────────────────────────────────────────────────

const ALL_PRESETS: DelayPreset[] = ['conservadora', 'normal', 'agresiva']

// ── Servicio ──────────────────────────────────────────────────────────────────

export class WarmingEffectivenessService {
  computeReport(lines: EffectivenessLineInput[]): EffectivenessReport {
    if (lines.length === 0) {
      return {
        totalLines: 0, activeLines: 0, pausedLines: 0,
        completedLines: 0, bannedLines: 0,
        overallSuccessRate: 0, completionRatio: 0, banRate: 0,
        byStrategy: [], topPerformingStrategy: null,
        generatedAt: new Date().toISOString(),
      }
    }

    const total     = lines.length
    const active    = lines.filter(l => l.warmup_status === 'active').length
    const paused    = lines.filter(l => l.warmup_status === 'paused').length
    const completed = lines.filter(l => l.warmup_status === 'completed').length
    const banned    = lines.filter(l => l.warmup_status === 'banned').length

    const terminal          = completed + banned
    const overallSuccessRate = terminal > 0 ? Math.round((completed / terminal) * 100) : 0
    const completionRatio    = Math.round((completed / total) * 100)
    const banRate            = Math.round((banned / total) * 100)

    const byStrategy = ALL_PRESETS
      .map(p => this.computeStrategyMetrics(lines, p))
      .filter(m => m.totalLines > 0)

    return {
      totalLines: total, activeLines: active, pausedLines: paused,
      completedLines: completed, bannedLines: banned,
      overallSuccessRate, completionRatio, banRate,
      byStrategy,
      topPerformingStrategy: this.resolveTopStrategy(byStrategy),
      generatedAt: new Date().toISOString(),
    }
  }

  computeStrategyMetrics(lines: EffectivenessLineInput[], preset: DelayPreset): StrategyMetrics {
    const filtered = lines.filter(l => l.delay_preset === preset)
    const total    = filtered.length

    if (total === 0) {
      return {
        preset, totalLines: 0, activeLines: 0, pausedLines: 0,
        completedLines: 0, bannedLines: 0,
        successRate: 0, completionRatio: 0,
        avgCurrentDay: 0, avgHealthScore: 0,
      }
    }

    const active    = filtered.filter(l => l.warmup_status === 'active').length
    const paused    = filtered.filter(l => l.warmup_status === 'paused').length
    const completed = filtered.filter(l => l.warmup_status === 'completed').length
    const banned    = filtered.filter(l => l.warmup_status === 'banned').length

    const terminal        = completed + banned
    const successRate     = terminal > 0 ? Math.round((completed / terminal) * 100) : 0
    const completionRatio = Math.round((completed / total) * 100)

    const avgCurrentDay  = Math.round(filtered.reduce((s, l) => s + l.current_day,  0) / total)
    const avgHealthScore = Math.round(filtered.reduce((s, l) => s + l.health_score, 0) / total)

    return {
      preset, totalLines: total, activeLines: active, pausedLines: paused,
      completedLines: completed, bannedLines: banned,
      successRate, completionRatio,
      avgCurrentDay, avgHealthScore,
    }
  }

  private resolveTopStrategy(strategies: StrategyMetrics[]): DelayPreset | null {
    if (strategies.length === 0) return null

    const withTerminal = strategies.filter(s => s.completedLines + s.bannedLines > 0)
    if (withTerminal.length === 0) {
      // Sin terminales aún → la de mayor salud promedio
      return [...strategies].sort((a, b) => b.avgHealthScore - a.avgHealthScore)[0]?.preset ?? null
    }

    return [...withTerminal].sort((a, b) =>
      b.successRate !== a.successRate
        ? b.successRate - a.successRate
        : b.completedLines - a.completedLines
    )[0].preset
  }
}

export const warmingEffectivenessService = new WarmingEffectivenessService()
