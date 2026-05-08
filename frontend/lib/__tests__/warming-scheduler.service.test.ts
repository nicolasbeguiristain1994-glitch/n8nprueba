/**
 * warming-scheduler.service.test.ts
 * @vitest-environment node
 *
 * Tests unitarios para WarmingSchedulerService.
 * No requiere conexión a DB — el servicio es puro.
 */

import { describe, it, expect } from 'vitest'
import {
  WarmingSchedulerService,
  type ScheduleInput,
} from '@/lib/services/warming/warming-scheduler.service'

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildInput(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    current_day:         7,
    target_days:         21,
    health_score:        80,
    delay_preset:        'normal',
    warmup_status:       'active',
    messages_sent_today: 0,
    ...overrides,
  }
}

const svc = new WarmingSchedulerService()

// ── Líneas inactivas ──────────────────────────────────────────────────────────

describe('WarmingSchedulerService — estados no activos', () => {
  it.each(['paused', 'completed', 'banned'] as const)(
    'status=%s → dailyQuota=0 y shouldSendToday=false',
    (status) => {
      const result = svc.getDailyQuota(buildInput({ warmup_status: status }))
      expect(result.dailyQuota).toBe(0)
      expect(result.shouldSendToday).toBe(false)
      expect(result.remainingToday).toBe(0)
    },
  )
})

// ── Cuota base ────────────────────────────────────────────────────────────────

describe('WarmingSchedulerService — cuota diaria', () => {
  it('salud ≥ 80 no penaliza la cuota (factor 1.00)', () => {
    const result = svc.getDailyQuota(buildInput({ health_score: 90 }))
    expect(result.adjustment.factor).toBe(1.00)
    expect(result.dailyQuota).toBe(result.baseQuota)
  })

  it('salud en [60,80) aplica factor 0.90', () => {
    const result = svc.getDailyQuota(buildInput({ health_score: 70 }))
    expect(result.adjustment.factor).toBe(0.90)
    expect(result.dailyQuota).toBeLessThan(result.baseQuota)
  })

  it('salud en [40,60) aplica factor 0.75', () => {
    const result = svc.getDailyQuota(buildInput({ health_score: 50 }))
    expect(result.adjustment.factor).toBe(0.75)
  })

  it('salud en [20,40) aplica factor 0.50', () => {
    const result = svc.getDailyQuota(buildInput({ health_score: 30 }))
    expect(result.adjustment.factor).toBe(0.50)
  })

  it('salud < 20 aplica factor 0.25 (modo emergencia)', () => {
    const result = svc.getDailyQuota(buildInput({ health_score: 10 }))
    expect(result.adjustment.factor).toBe(0.25)
    expect(result.adjustment.reason).toContain('emergencia')
  })

  it('cuota mínima siempre es 1 (nunca 0 para líneas activas con cuota)', () => {
    // Incluso con salud crítica y estrategia conservadora
    const result = svc.getDailyQuota(buildInput({
      health_score:  5,
      delay_preset:  'conservadora',
      current_day:   1,
      target_days:   30,
    }))
    expect(result.dailyQuota).toBeGreaterThanOrEqual(1)
  })
})

// ── Estrategias ───────────────────────────────────────────────────────────────

describe('WarmingSchedulerService — modificadores de estrategia', () => {
  const baseInput = buildInput({ health_score: 80, current_day: 14, target_days: 21 })

  it('conservadora reduce la cuota (factor 0.70)', () => {
    const result = svc.getDailyQuota({ ...baseInput, delay_preset: 'conservadora' })
    expect(result.strategyFactor).toBe(0.70)
  })

  it('normal no modifica la cuota (factor 1.00)', () => {
    const result = svc.getDailyQuota({ ...baseInput, delay_preset: 'normal' })
    expect(result.strategyFactor).toBe(1.00)
  })

  it('agresiva amplía la cuota (factor 1.30)', () => {
    const result = svc.getDailyQuota({ ...baseInput, delay_preset: 'agresiva' })
    expect(result.strategyFactor).toBe(1.30)
  })

  it('conservadora < normal < agresiva (mismas condiciones)', () => {
    const cons = svc.getDailyQuota({ ...baseInput, delay_preset: 'conservadora' })
    const norm = svc.getDailyQuota({ ...baseInput, delay_preset: 'normal' })
    const agre = svc.getDailyQuota({ ...baseInput, delay_preset: 'agresiva' })
    expect(cons.dailyQuota).toBeLessThan(norm.dailyQuota)
    expect(norm.dailyQuota).toBeLessThan(agre.dailyQuota)
  })
})

// ── remainingToday y shouldSendToday ─────────────────────────────────────────

describe('WarmingSchedulerService — remaining y shouldSend', () => {
  it('remaining = dailyQuota cuando messages_sent_today = 0', () => {
    const result = svc.getDailyQuota(buildInput({ messages_sent_today: 0 }))
    expect(result.remainingToday).toBe(result.dailyQuota)
    expect(result.shouldSendToday).toBe(true)
  })

  it('remaining = 0 cuando ya se alcanzó la cuota', () => {
    const result = svc.getDailyQuota(buildInput({
      messages_sent_today: 100, // supera cualquier cuota
    }))
    expect(result.remainingToday).toBe(0)
    expect(result.shouldSendToday).toBe(false)
  })

  it('remaining decrece a medida que se envían mensajes', () => {
    const r0 = svc.getDailyQuota(buildInput({ messages_sent_today: 0 }))
    const r3 = svc.getDailyQuota(buildInput({ messages_sent_today: 3 }))
    if (r0.dailyQuota > 3) {
      expect(r3.remainingToday).toBe(r0.remainingToday - 3)
    }
  })
})

// ── Fases ─────────────────────────────────────────────────────────────────────

describe('WarmingSchedulerService — etiqueta de fase', () => {
  it.each([
    [1,  'Fase 1: Fundación (Día 1–7)'],
    [7,  'Fase 1: Fundación (Día 1–7)'],
    [8,  'Fase 2: Crecimiento (Día 8–14)'],
    [14, 'Fase 2: Crecimiento (Día 8–14)'],
    [15, 'Fase 3: Maduración (Día 15+)'],
    [30, 'Fase 3: Maduración (Día 15+)'],
  ])('día %i → %s', (day, expected) => {
    expect(svc.phaseLabel(day)).toBe(expected)
  })
})

// ── Combinación salud + estrategia ───────────────────────────────────────────

describe('WarmingSchedulerService — interacción salud × estrategia', () => {
  it('salud crítica + agresiva ≈ salud óptima + conservadora', () => {
    // Salud crítica (×0.25) × agresiva (×1.30) = ×0.325
    // Salud óptima  (×1.00) × conservadora (×0.70) = ×0.70
    // La agresiva con salud crítica no supera la conservadora con salud óptima
    const critica = svc.getDailyQuota(buildInput({ health_score: 10, delay_preset: 'agresiva', current_day: 14 }))
    const optima  = svc.getDailyQuota(buildInput({ health_score: 90, delay_preset: 'conservadora', current_day: 14 }))
    expect(critica.dailyQuota).toBeLessThan(optima.dailyQuota)
  })
})
