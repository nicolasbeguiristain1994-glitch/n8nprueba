/**
 * warming-effectiveness.service.test.ts
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest'
import {
  WarmingEffectivenessService,
  type EffectivenessLineInput,
} from '@/lib/services/warming/warming-effectiveness.service'

const svc = new WarmingEffectivenessService()

function buildLine(overrides: Partial<EffectivenessLineInput> = {}): EffectivenessLineInput {
  return {
    id:            'line-1',
    warmup_status: 'active',
    current_day:   7,
    target_days:   21,
    delay_preset:  'normal',
    health_score:  65,
    ...overrides,
  }
}

// ── computeReport — sin líneas ────────────────────────────────────────────────

describe('WarmingEffectivenessService — sin líneas', () => {
  it('lista vacía → reporte con ceros y byStrategy vacío', () => {
    const r = svc.computeReport([])
    expect(r.totalLines).toBe(0)
    expect(r.byStrategy).toHaveLength(0)
    expect(r.topPerformingStrategy).toBeNull()
  })
})

// ── computeReport — totales ───────────────────────────────────────────────────

describe('WarmingEffectivenessService — totales', () => {
  it('contabiliza líneas por estado correctamente', () => {
    const lines = [
      buildLine({ id: 'a', warmup_status: 'active' }),
      buildLine({ id: 'b', warmup_status: 'active' }),
      buildLine({ id: 'c', warmup_status: 'paused' }),
      buildLine({ id: 'd', warmup_status: 'completed' }),
      buildLine({ id: 'e', warmup_status: 'banned' }),
    ]
    const r = svc.computeReport(lines)
    expect(r.totalLines).toBe(5)
    expect(r.activeLines).toBe(2)
    expect(r.pausedLines).toBe(1)
    expect(r.completedLines).toBe(1)
    expect(r.bannedLines).toBe(1)
  })

  it('overallSuccessRate = completed / (completed + banned) × 100', () => {
    const lines = [
      buildLine({ id: 'a', warmup_status: 'completed' }),
      buildLine({ id: 'b', warmup_status: 'completed' }),
      buildLine({ id: 'c', warmup_status: 'banned' }),
    ]
    const r = svc.computeReport(lines)
    expect(r.overallSuccessRate).toBe(67)  // round(2/3*100)
  })

  it('overallSuccessRate = 0 cuando no hay líneas terminales', () => {
    const lines = [buildLine(), buildLine({ id: 'b' })]
    const r = svc.computeReport(lines)
    expect(r.overallSuccessRate).toBe(0)
  })

  it('completionRatio = completed / total × 100', () => {
    const lines = [
      buildLine({ id: 'a', warmup_status: 'completed' }),
      buildLine({ id: 'b', warmup_status: 'active' }),
      buildLine({ id: 'c', warmup_status: 'active' }),
      buildLine({ id: 'd', warmup_status: 'active' }),
    ]
    const r = svc.computeReport(lines)
    expect(r.completionRatio).toBe(25)  // 1/4
  })

  it('banRate = banned / total × 100', () => {
    const lines = [
      buildLine({ id: 'a', warmup_status: 'banned' }),
      buildLine({ id: 'b', warmup_status: 'active' }),
    ]
    const r = svc.computeReport(lines)
    expect(r.banRate).toBe(50)
  })

  it('generatedAt es un ISO string válido', () => {
    const r = svc.computeReport([buildLine()])
    expect(() => new Date(r.generatedAt)).not.toThrow()
  })
})

// ── computeStrategyMetrics ────────────────────────────────────────────────────

describe('WarmingEffectivenessService — computeStrategyMetrics', () => {
  it('preset sin líneas → métricas en cero', () => {
    const m = svc.computeStrategyMetrics([], 'agresiva')
    expect(m.totalLines).toBe(0)
    expect(m.successRate).toBe(0)
  })

  it('agrupa correctamente por preset', () => {
    const lines = [
      buildLine({ id: 'a', delay_preset: 'normal',       warmup_status: 'completed' }),
      buildLine({ id: 'b', delay_preset: 'normal',       warmup_status: 'active' }),
      buildLine({ id: 'c', delay_preset: 'conservadora', warmup_status: 'active' }),
    ]
    const mNormal = svc.computeStrategyMetrics(lines, 'normal')
    const mCons   = svc.computeStrategyMetrics(lines, 'conservadora')

    expect(mNormal.totalLines).toBe(2)
    expect(mNormal.completedLines).toBe(1)
    expect(mCons.totalLines).toBe(1)
    expect(mCons.completedLines).toBe(0)
  })

  it('avgHealthScore = promedio de health_score del grupo', () => {
    const lines = [
      buildLine({ id: 'a', delay_preset: 'agresiva', health_score: 80 }),
      buildLine({ id: 'b', delay_preset: 'agresiva', health_score: 60 }),
    ]
    const m = svc.computeStrategyMetrics(lines, 'agresiva')
    expect(m.avgHealthScore).toBe(70)
  })
})

// ── topPerformingStrategy ─────────────────────────────────────────────────────

describe('WarmingEffectivenessService — topPerformingStrategy', () => {
  it('sin líneas terminales → estrategia con mayor salud promedio', () => {
    const lines = [
      buildLine({ id: 'a', delay_preset: 'normal',       health_score: 50 }),
      buildLine({ id: 'b', delay_preset: 'conservadora', health_score: 80 }),
    ]
    const r = svc.computeReport(lines)
    expect(r.topPerformingStrategy).toBe('conservadora')
  })

  it('con terminales → estrategia con mayor successRate', () => {
    const lines = [
      buildLine({ id: 'a', delay_preset: 'agresiva',     warmup_status: 'completed' }),
      buildLine({ id: 'b', delay_preset: 'agresiva',     warmup_status: 'banned' }),   // 50%
      buildLine({ id: 'c', delay_preset: 'conservadora', warmup_status: 'completed' }), // 100%
    ]
    const r = svc.computeReport(lines)
    expect(r.topPerformingStrategy).toBe('conservadora')
  })

  it('byStrategy solo incluye presets con líneas', () => {
    const lines = [buildLine({ delay_preset: 'normal' })]
    const r = svc.computeReport(lines)
    expect(r.byStrategy.every(s => s.totalLines > 0)).toBe(true)
  })
})
