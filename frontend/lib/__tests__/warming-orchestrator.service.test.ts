/**
 * warming-orchestrator.service.test.ts
 * @vitest-environment node
 *
 * Tests unitarios para WarmingOrchestratorService.
 * Servicio puro — no requiere DB ni reloj del sistema.
 */

import { describe, it, expect } from 'vitest'
import { getDailyLimitForDay } from '@/lib/warmup-engine'
import {
  WarmingOrchestratorService,
  type OrchestratorLineInput,
  type HealthHistoryPoint,
} from '@/lib/services/warming/warming-orchestrator.service'
import type { HealthComponents } from '@/lib/services/warming/health-calculator.service'

// ── Factory helpers ────────────────────────────────────────────────────────────

function buildLine(overrides: Partial<OrchestratorLineInput> = {}): OrchestratorLineInput {
  return {
    id:                   'line-1',
    warmup_status:        'active',
    current_day:          7,
    target_days:          21,
    effectiveDailyLimit:  getDailyLimitForDay(7, 21),
    messages_sent_today:  0,
    daysSinceLastMessage: 0,
    delay_preset:         'normal',
    recent7days:          [],
    ...overrides,
  }
}

function buildHistoryPoint(score: number, overrides: Partial<HealthHistoryPoint> = {}): HealthHistoryPoint {
  const components: HealthComponents = {
    base: 30, progressScore: 10, trendScore: 8,
    activityScore: 6, inactivityPenalty: 0, failurePenalty: 0,
  }
  return {
    recordedAt:   new Date().toISOString(),
    score,
    components,
    dailyQuota:   20,
    messagesSent: 15,
    ...overrides,
  }
}

const svc = new WarmingOrchestratorService()

// ── orchestrate() — caso base ─────────────────────────────────────────────────

describe('WarmingOrchestratorService — orchestrate()', () => {
  it('lista vacía → totales en cero y orchestratedAt presente', () => {
    const result = svc.orchestrate([])
    expect(result.totalActiveLines).toBe(0)
    expect(result.totalDailyQuota).toBe(0)
    expect(result.totalRemainingToday).toBe(0)
    expect(result.orchestratedAt).toBeTruthy()
    expect(result.lines).toHaveLength(0)
  })

  it('línea activa devuelve health + schedule calculados', () => {
    const result = svc.orchestrate([buildLine()])
    expect(result.lines).toHaveLength(1)
    const r = result.lines[0]
    expect(r.lineId).toBe('line-1')
    expect(r.health.score).toBeGreaterThan(0)
    expect(r.schedule.dailyQuota).toBeGreaterThan(0)
  })

  it('línea baneada → score 0, shouldSendToday false, weight 0', () => {
    const result = svc.orchestrate([buildLine({ id: 'banned', warmup_status: 'banned' })])
    const r = result.lines[0]
    expect(r.health.score).toBe(0)
    expect(r.schedule.shouldSendToday).toBe(false)
    expect(r.weight).toBe(0)
    expect(result.totalActiveLines).toBe(0)
  })

  it('línea pausada → shouldSendToday false, weight 0', () => {
    const result = svc.orchestrate([buildLine({ warmup_status: 'paused' })])
    expect(result.lines[0].schedule.shouldSendToday).toBe(false)
    expect(result.lines[0].weight).toBe(0)
  })

  it('dos líneas activas → pesos suman 1', () => {
    const result = svc.orchestrate([
      buildLine({ id: 'a', messages_sent_today: 0 }),
      buildLine({ id: 'b', messages_sent_today: 0 }),
    ])
    const total = result.lines.reduce((s, r) => s + r.weight, 0)
    expect(total).toBeCloseTo(1, 5)
  })

  it('totalDailyQuota = suma de dailyQuota de cada línea', () => {
    const result = svc.orchestrate([
      buildLine({ id: 'x' }),
      buildLine({ id: 'y' }),
    ])
    const expected = result.lines.reduce((s, r) => s + r.schedule.dailyQuota, 0)
    expect(result.totalDailyQuota).toBe(expected)
  })

  it('totalRemainingToday = suma de remainingToday de cada línea', () => {
    const result = svc.orchestrate([
      buildLine({ id: 'p', messages_sent_today: 5 }),
      buildLine({ id: 'q', messages_sent_today: 10 }),
    ])
    const expected = result.lines.reduce((s, r) => s + r.schedule.remainingToday, 0)
    expect(result.totalRemainingToday).toBe(expected)
  })

  it('totalActiveLines = cantidad de líneas con shouldSendToday true', () => {
    const result = svc.orchestrate([
      buildLine({ id: 'active' }),
      buildLine({ id: 'paused', warmup_status: 'paused' }),
    ])
    expect(result.totalActiveLines).toBe(1)
  })

  it('línea con alta salud recibe mayor peso que línea con baja salud', () => {
    const result = svc.orchestrate([
      buildLine({ id: 'high', current_day: 20, recent7days: Array.from({ length: 7 }, (_, i) => ({ date: `2026-05-0${i+1}`, sent: 10, failed: 0 })) }),
      buildLine({ id: 'low',  current_day: 1,  recent7days: [] }),
    ])
    const high = result.lines.find(r => r.lineId === 'high')!
    const low  = result.lines.find(r => r.lineId === 'low')!
    expect(high.weight).toBeGreaterThan(low.weight)
  })
})

// ── computeLineWeight() ───────────────────────────────────────────────────────

describe('WarmingOrchestratorService — computeLineWeight()', () => {
  it('shouldSendToday false → 0', () => {
    expect(svc.computeLineWeight(80, false, 200)).toBe(0)
  })

  it('totalActiveHealthScore 0 → 0 (evita división por cero)', () => {
    expect(svc.computeLineWeight(80, true, 0)).toBe(0)
  })

  it('única línea activa → peso 1', () => {
    expect(svc.computeLineWeight(70, true, 70)).toBeCloseTo(1)
  })

  it('dos líneas con mismo score → peso 0.5 cada una', () => {
    expect(svc.computeLineWeight(50, true, 100)).toBeCloseTo(0.5)
  })

  it('score más alto → peso mayor', () => {
    const high = svc.computeLineWeight(80, true, 110)
    const low  = svc.computeLineWeight(30, true, 110)
    expect(high).toBeGreaterThan(low)
  })
})

// ── calculateTrend() ──────────────────────────────────────────────────────────

describe('WarmingOrchestratorService — calculateTrend()', () => {
  it('historial vacío → stable, delta 0', () => {
    const t = svc.calculateTrend([])
    expect(t.direction).toBe('stable')
    expect(t.delta).toBe(0)
  })

  it('un solo punto → stable', () => {
    const t = svc.calculateTrend([buildHistoryPoint(60)])
    expect(t.direction).toBe('stable')
    expect(t.delta).toBe(0)
  })

  it('delta ≥ 5 → improving', () => {
    // history[0] = más reciente; history[last] = más antiguo
    const history = [buildHistoryPoint(80), buildHistoryPoint(70)]
    const t = svc.calculateTrend(history)
    expect(t.direction).toBe('improving')
    expect(t.delta).toBe(10)
  })

  it('delta ≤ −5 → declining', () => {
    const history = [buildHistoryPoint(60), buildHistoryPoint(75)]
    const t = svc.calculateTrend(history)
    expect(t.direction).toBe('declining')
    expect(t.delta).toBe(-15)
  })

  it('delta entre −4 y +4 → stable', () => {
    const history = [buildHistoryPoint(62), buildHistoryPoint(60)]
    const t = svc.calculateTrend(history)
    expect(t.direction).toBe('stable')
  })

  it('calcula averageScore correctamente', () => {
    const history = [buildHistoryPoint(80), buildHistoryPoint(60), buildHistoryPoint(40)]
    const t = svc.calculateTrend(history)
    expect(t.averageScore).toBe(60)
  })

  it('calcula minScore y maxScore correctamente', () => {
    const history = [buildHistoryPoint(90), buildHistoryPoint(50), buildHistoryPoint(30)]
    const t = svc.calculateTrend(history)
    expect(t.minScore).toBe(30)
    expect(t.maxScore).toBe(90)
  })
})

// ── summarizeHistory() ────────────────────────────────────────────────────────

describe('WarmingOrchestratorService — summarizeHistory()', () => {
  it('historial vacío → totalPoints 0, latestScore -1', () => {
    const s = svc.summarizeHistory([])
    expect(s.totalPoints).toBe(0)
    expect(s.latestScore).toBe(-1)
  })

  it('totalPoints = length del historial', () => {
    const history = [buildHistoryPoint(70), buildHistoryPoint(65), buildHistoryPoint(60)]
    const s = svc.summarizeHistory(history)
    expect(s.totalPoints).toBe(3)
  })

  it('latestScore = score del primer elemento (más reciente)', () => {
    const history = [buildHistoryPoint(85), buildHistoryPoint(70)]
    const s = svc.summarizeHistory(history)
    expect(s.latestScore).toBe(85)
  })

  it('averageScore redondeado correctamente', () => {
    const history = [buildHistoryPoint(70), buildHistoryPoint(71)]
    const s = svc.summarizeHistory(history)
    expect(s.averageScore).toBe(71) // round((70+71)/2) = round(70.5) = 71
  })

  it('trend incluido correctamente en el resumen', () => {
    const history = [buildHistoryPoint(90), buildHistoryPoint(70)]
    const s = svc.summarizeHistory(history)
    expect(s.trend.direction).toBe('improving')
    expect(s.trend.delta).toBe(20)
  })
})
