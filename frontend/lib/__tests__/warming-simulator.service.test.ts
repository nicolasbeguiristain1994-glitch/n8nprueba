/**
 * warming-simulator.service.test.ts
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest'
import {
  WarmingSimulatorService,
  type SimulatorLineInput,
  type SimulatorInput,
} from '@/lib/services/warming/warming-simulator.service'

const svc = new WarmingSimulatorService()

function buildLine(overrides: Partial<SimulatorLineInput> = {}): SimulatorLineInput {
  return {
    id:                  'line-1',
    warmup_status:       'active',
    current_day:         7,
    target_days:         21,
    health_score:        70,
    delay_preset:        'normal',
    messages_sent_today: 0,
    trendDelta:          0,
    ...overrides,
  }
}

function buildInput(overrides: Partial<SimulatorInput> = {}): SimulatorInput {
  return {
    scenario:     'project_health',
    currentLines: [buildLine()],
    ...overrides,
  }
}

// ── add_lines ─────────────────────────────────────────────────────────────────

describe('WarmingSimulatorService — add_lines', () => {
  it('agrega 3 líneas nuevas con cuota > 0', () => {
    const r = svc.simulate(buildInput({
      scenario:        'add_lines',
      currentLines:    [buildLine()],
      newLinesCount:   3,
      newLinesStrategy: 'normal',
    }))
    expect(r.projections).toHaveLength(3)
    expect(r.projections.every(p => p.projectedDailyQuota > 0)).toBe(true)
  })

  it('cuota proyectada total > cuota actual', () => {
    const r = svc.simulate(buildInput({
      scenario:       'add_lines',
      currentLines:   [buildLine()],
      newLinesCount:  2,
    }))
    expect(r.totals.projectedQuota).toBeGreaterThan(r.totals.currentQuota)
    expect(r.totals.quotaChange).toBeGreaterThan(0)
  })

  it('estrategia agresiva + muchas líneas → riskLevel high', () => {
    const r = svc.simulate(buildInput({
      scenario:         'add_lines',
      currentLines:     [],
      newLinesCount:    6,
      newLinesStrategy: 'agresiva',
    }))
    expect(r.insights.riskLevel).toBe('high')
  })

  it('estrategia normal con pocas líneas → riskLevel low', () => {
    const r = svc.simulate(buildInput({
      scenario:         'add_lines',
      currentLines:     [],
      newLinesCount:    2,
      newLinesStrategy: 'normal',
    }))
    expect(r.insights.riskLevel).toBe('low')
  })

  it('newLinesCount default 1 cuando no se pasa', () => {
    const r = svc.simulate(buildInput({ scenario: 'add_lines', currentLines: [] }))
    expect(r.projections).toHaveLength(1)
  })

  it('currentDailyQuota de líneas nuevas es 0 (aún no existen)', () => {
    const r = svc.simulate(buildInput({ scenario: 'add_lines', newLinesCount: 2 }))
    expect(r.projections.every(p => p.currentDailyQuota === 0)).toBe(true)
  })
})

// ── change_strategy ───────────────────────────────────────────────────────────

describe('WarmingSimulatorService — change_strategy', () => {
  it('cambiar a agresiva → cuota proyectada mayor', () => {
    const r = svc.simulate(buildInput({
      scenario:       'change_strategy',
      targetStrategy: 'agresiva',
    }))
    expect(r.totals.projectedQuota).toBeGreaterThan(r.totals.currentQuota)
  })

  it('cambiar a conservadora → cuota proyectada menor', () => {
    const r = svc.simulate(buildInput({
      scenario:       'change_strategy',
      targetStrategy: 'conservadora',
    }))
    expect(r.totals.projectedQuota).toBeLessThan(r.totals.currentQuota)
  })

  it('con lineIds vacío aplica a todas las activas', () => {
    const lines = [
      buildLine({ id: 'a' }),
      buildLine({ id: 'b' }),
    ]
    const r = svc.simulate(buildInput({
      scenario:       'change_strategy',
      currentLines:   lines,
      targetStrategy: 'agresiva',
      lineIds:        [],
    }))
    expect(r.projections.every(p => p.changeNote.includes('agresiva'))).toBe(true)
  })

  it('con lineIds específico solo afecta esas líneas', () => {
    const lines = [buildLine({ id: 'a' }), buildLine({ id: 'b' })]
    const r = svc.simulate(buildInput({
      scenario:       'change_strategy',
      currentLines:   lines,
      targetStrategy: 'agresiva',
      lineIds:        ['a'],
    }))
    const projA = r.projections.find(p => p.lineId === 'a')!
    const projB = r.projections.find(p => p.lineId === 'b')!
    expect(projA.changeNote).toContain('agresiva')
    expect(projB.changeNote).toBe('Sin cambio')
  })

  it('líneas pausadas aparecen en proyección', () => {
    const r = svc.simulate(buildInput({
      scenario:       'change_strategy',
      currentLines:   [buildLine({ warmup_status: 'paused' })],
      targetStrategy: 'normal',
    }))
    expect(r.projections).toHaveLength(1)
  })

  it('líneas completadas y baneadas no aparecen en proyección', () => {
    const r = svc.simulate(buildInput({
      scenario:       'change_strategy',
      currentLines:   [buildLine({ warmup_status: 'completed' }), buildLine({ id: 'b', warmup_status: 'banned' })],
      targetStrategy: 'agresiva',
    }))
    expect(r.projections).toHaveLength(0)
  })
})

// ── project_health ────────────────────────────────────────────────────────────

describe('WarmingSimulatorService — project_health', () => {
  it('proyección 14 días con tendencia positiva → score proyectado mayor', () => {
    const r = svc.simulate(buildInput({
      scenario:       'project_health',
      currentLines:   [buildLine({ health_score: 60, trendDelta: 14 })],  // +2/día
      projectionDays: 14,
    }))
    expect(r.projections[0].projectedHealthScore).toBeGreaterThan(60)
  })

  it('proyección con tendencia negativa → score proyectado menor', () => {
    const r = svc.simulate(buildInput({
      scenario:       'project_health',
      currentLines:   [buildLine({ health_score: 70, trendDelta: -14 })],  // -2/día
      projectionDays: 7,
    }))
    expect(r.projections[0].projectedHealthScore).toBeLessThan(70)
  })

  it('score proyectado no supera 100', () => {
    const r = svc.simulate(buildInput({
      scenario:       'project_health',
      currentLines:   [buildLine({ health_score: 95, trendDelta: 21 })],
      projectionDays: 14,
    }))
    expect(r.projections[0].projectedHealthScore).toBeLessThanOrEqual(100)
  })

  it('score proyectado no baja de 0', () => {
    const r = svc.simulate(buildInput({
      scenario:       'project_health',
      currentLines:   [buildLine({ health_score: 5, trendDelta: -70 })],
      projectionDays: 14,
    }))
    expect(r.projections[0].projectedHealthScore).toBeGreaterThanOrEqual(0)
  })

  it('inputSummary menciona los días de proyección', () => {
    const r = svc.simulate(buildInput({
      scenario:       'project_health',
      projectionDays: 21,
    }))
    expect(r.inputSummary).toContain('21')
  })

  it('líneas no activas no aparecen en proyección', () => {
    const r = svc.simulate(buildInput({
      scenario:       'project_health',
      currentLines:   [
        buildLine({ id: 'a', warmup_status: 'active' }),
        buildLine({ id: 'b', warmup_status: 'paused' }),
        buildLine({ id: 'c', warmup_status: 'completed' }),
      ],
    }))
    expect(r.projections).toHaveLength(1)
    expect(r.projections[0].lineId).toBe('a')
  })

  it('riskLevel high cuando > 30% de líneas proyectan score < 30', () => {
    const r = svc.simulate(buildInput({
      scenario:       'project_health',
      currentLines:   [
        buildLine({ id: 'a', health_score: 10, trendDelta: -14 }),  // proyectará < 30
        buildLine({ id: 'b', health_score: 10, trendDelta: -14 }),  // proyectará < 30
        buildLine({ id: 'c', health_score: 80, trendDelta: 0 }),
      ],
      projectionDays: 7,
    }))
    expect(r.insights.riskLevel).toBe('high')
  })
})

// ── helper: quota ─────────────────────────────────────────────────────────────

describe('WarmingSimulatorService — quota()', () => {
  it('cuota mínima es siempre ≥ 1', () => {
    expect(svc.quota(1, 21, 0, 'conservadora')).toBeGreaterThanOrEqual(1)
  })

  it('estrategia agresiva produce cuota > normal', () => {
    const qN = svc.quota(7, 21, 70, 'normal')
    const qA = svc.quota(7, 21, 70, 'agresiva')
    expect(qA).toBeGreaterThan(qN)
  })

  it('estrategia conservadora produce cuota < normal', () => {
    const qN = svc.quota(7, 21, 70, 'normal')
    const qC = svc.quota(7, 21, 70, 'conservadora')
    expect(qC).toBeLessThan(qN)
  })
})
