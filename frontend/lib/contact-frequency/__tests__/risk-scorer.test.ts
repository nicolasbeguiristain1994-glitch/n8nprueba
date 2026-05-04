/**
 * risk-scorer.test.ts
 *
 * Tests unitarios de calculateRiskScore().
 * Módulo puro: sin DB, sin mocks. Solo inputs → outputs.
 *
 * Cobertura:
 *  ─ Bloqueos duros: límite diario, límite semanal, cool-down activo
 *  ─ Score proporcional: componentes individuales y suma
 *  ─ Decisiones: ALLOW / DELAY / BLOCK por score
 *  ─ Edge cases: primer envío, min_hours=0, límites en exactamente el umbral
 *  ─ Fix bug cooldown: ventana proporcional = min_hours × 2
 */

import { describe, it, expect } from 'vitest'
import { calculateRiskScore }   from '../risk-scorer'
import { DEFAULT_GLOBAL_RULE }  from '../rules'
import type { ContactFrequencyProfile, ContactFrequencyRule } from '../types'

// ── Factories ─────────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<ContactFrequencyProfile> = {}): ContactFrequencyProfile {
  return {
    sentToday:          0,
    sentThisWeek:       0,
    lastSentAt:         null,
    hoursSinceLastSend: null,
    ...overrides,
  }
}

function makeRule(overrides: Partial<ContactFrequencyRule> = {}): ContactFrequencyRule {
  return { ...DEFAULT_GLOBAL_RULE, ...overrides }
}

// ── Bloqueos duros ────────────────────────────────────────────────────────────

describe('calculateRiskScore — bloqueos duros', () => {

  it('bloquea cuando sentToday >= max_per_day', () => {
    const result = calculateRiskScore(
      makeProfile({ sentToday: 1, sentThisWeek: 1 }),
      makeRule({ max_per_day: 1 }),
    )
    expect(result.decision).toBe('BLOCK')
    expect(result.riskScore).toBe(100)
    expect(result.reason).toContain('Límite diario')
    expect(result.reason).toContain('1/1')
  })

  it('bloquea cuando sentToday > max_per_day (sobrepasado)', () => {
    const result = calculateRiskScore(
      makeProfile({ sentToday: 3, sentThisWeek: 3 }),
      makeRule({ max_per_day: 1 }),
    )
    expect(result.decision).toBe('BLOCK')
    expect(result.riskScore).toBe(100)
  })

  it('bloquea cuando sentThisWeek >= max_per_week', () => {
    const result = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 2 }),
      makeRule({ max_per_week: 2 }),
    )
    expect(result.decision).toBe('BLOCK')
    expect(result.riskScore).toBe(100)
    expect(result.reason).toContain('Límite semanal')
    expect(result.reason).toContain('2/2')
  })

  it('bloqueo diario tiene precedencia sobre bloqueo semanal', () => {
    const result = calculateRiskScore(
      makeProfile({ sentToday: 1, sentThisWeek: 2 }),
      makeRule({ max_per_day: 1, max_per_week: 2 }),
    )
    expect(result.reason).toContain('Límite diario')
  })

  it('bloquea cuando cool-down activo (hoursSinceLastSend < min_hours)', () => {
    const result = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 1, hoursSinceLastSend: 24 }),
      makeRule({ min_hours_between_sends: 48 }),
    )
    expect(result.decision).toBe('BLOCK')
    expect(result.riskScore).toBe(100)
    expect(result.reason).toContain('Cool-down activo')
    expect(result.reason).toContain('24h restantes')
  })

  it('cool-down: calcula horas restantes correctamente', () => {
    const result = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 1, hoursSinceLastSend: 10.5 }),
      makeRule({ min_hours_between_sends: 48 }),
    )
    // remainingHours = Math.ceil(48 - 10.5) = 38
    expect(result.reason).toContain('38h restantes')
    expect(result.reason).toContain('10.5h')
  })

  it('NO bloquea cool-down cuando hoursSinceLastSend === min_hours exactamente', () => {
    const result = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 1, hoursSinceLastSend: 48.0 }),
      makeRule({ min_hours_between_sends: 48 }),
    )
    // 48 < 48 es false → no hay bloqueo duro
    expect(result.decision).not.toBe('BLOCK')
  })

  it('NO bloquea cool-down cuando min_hours_between_sends = 0', () => {
    const result = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 1, hoursSinceLastSend: 0.1 }),
      makeRule({ min_hours_between_sends: 0 }),
    )
    expect(result.decision).not.toBe('BLOCK')
    expect(result.reason).not.toContain('Cool-down')
  })

  it('NO bloquea cool-down cuando lastSentAt es null (primer envío)', () => {
    const result = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 0, hoursSinceLastSend: null }),
      makeRule({ min_hours_between_sends: 48 }),
    )
    expect(result.decision).toBe('ALLOW')
  })

})

// ── Score proporcional ────────────────────────────────────────────────────────

describe('calculateRiskScore — score proporcional', () => {

  it('contacto limpio (primer envío) → score = 0, ALLOW', () => {
    const result = calculateRiskScore(makeProfile(), makeRule())
    expect(result.decision).toBe('ALLOW')
    expect(result.riskScore).toBe(0)
    expect(result.components.dailyScore).toBe(0)
    expect(result.components.weeklyScore).toBe(0)
    expect(result.components.cooldownScore).toBe(0)
  })

  it('componente diario: 0 enviados de 1 max → 0 puntos', () => {
    const { components } = calculateRiskScore(
      makeProfile({ sentToday: 0 }),
      makeRule({ max_per_day: 1 }),
    )
    expect(components.dailyScore).toBe(0)
  })

  it('componente semanal: 1 enviado de 2 max → RISK_WEIGHTS.weekly × 0.5 = 17.5 puntos', () => {
    const { components } = calculateRiskScore(
      makeProfile({ sentThisWeek: 1 }),
      makeRule({ max_per_week: 2 }),
    )
    expect(components.weeklyScore).toBeCloseTo(17.5, 1)
  })

  // ── Fix Bug: cooldown siempre 0 en path proporcional ─────────────────────

  it('[BUG FIX] cooldown en exactamente el límite (48h) → score=12.5 (NO cero)', () => {
    // Antes del fix: ratio = 48/48 = 1 → inversePressure = 0 → score = 0 (bug)
    // Después del fix: ventana = 48×2 = 96 → ratio = 48/96 = 0.5 → score = 12.5
    const { components } = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 1, hoursSinceLastSend: 48 }),
      makeRule({ min_hours_between_sends: 48 }),
    )
    expect(components.cooldownScore).toBeCloseTo(12.5, 1)
  })

  it('[BUG FIX] cooldown 60h con min=48 → score≈9.4 (NO cero)', () => {
    // ventana = 96, ratio = 60/96 ≈ 0.625, inversePressure ≈ 0.375, score ≈ 9.375
    const { components } = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 1, hoursSinceLastSend: 60 }),
      makeRule({ min_hours_between_sends: 48 }),
    )
    expect(components.cooldownScore).toBeCloseTo(9.375, 1)
  })

  it('[BUG FIX] cooldown en 2× el mínimo (96h) → score = 0 (presión extinguida)', () => {
    // ventana = 96, ratio = 96/96 = 1.0, inversePressure = 0
    const { components } = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 1, hoursSinceLastSend: 96 }),
      makeRule({ min_hours_between_sends: 48 }),
    )
    expect(components.cooldownScore).toBe(0)
  })

  it('[BUG FIX] cooldown más de 2× el mínimo (120h) → score = 0 (clamped)', () => {
    // ventana = 96, ratio = 120/96 = 1.25, clamp → 0
    const { components } = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 1, hoursSinceLastSend: 120 }),
      makeRule({ min_hours_between_sends: 48 }),
    )
    expect(components.cooldownScore).toBe(0)
  })

  it('buildHardBlock calcula los componentes para diagnóstico (aunque score=100)', () => {
    // hoursSinceLastSend=24 < min=48 → bloqueo duro
    // ventana proporcional = 96, ratio = 24/96 = 0.25, score = 25 × 0.75 = 18.75
    const result = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 1, hoursSinceLastSend: 24 }),
      makeRule({ min_hours_between_sends: 48 }),
    )
    expect(result.decision).toBe('BLOCK')
    expect(result.riskScore).toBe(100)
    // Componente sigue calculado (para diagnóstico)
    expect(result.components.cooldownScore).toBeCloseTo(18.75, 1)
  })

  it('componente cool-down máximo: 0h desde último envío → 25 puntos', () => {
    // hoursSinceLastSend=0 → hard block, pero componente = 25×(1-0/96) = 25
    const result = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 1, hoursSinceLastSend: 0 }),
      makeRule({ min_hours_between_sends: 48 }),
    )
    expect(result.components.cooldownScore).toBeCloseTo(25, 1)
  })

  it('suma de componentes no supera 100', () => {
    // Contacto en el peor estado posible sin llegar a bloqueo duro
    const result = calculateRiskScore(
      makeProfile({
        sentToday:          0,
        sentThisWeek:       0,
        hoursSinceLastSend: 49,  // justo por encima del cool-down
      }),
      makeRule({
        max_per_day:             1,
        max_per_week:            2,
        min_hours_between_sends: 48,
      }),
    )
    expect(result.riskScore).toBeGreaterThanOrEqual(0)
    expect(result.riskScore).toBeLessThanOrEqual(100)
  })

})

// ── Decisiones por score ──────────────────────────────────────────────────────

describe('calculateRiskScore — decisiones por umbral', () => {

  it('score 0 → ALLOW', () => {
    const result = calculateRiskScore(makeProfile(), makeRule())
    expect(result.decision).toBe('ALLOW')
  })

  it('score ~17.5 (semanal 1/2, sin historial) → ALLOW (score ≤ 30)', () => {
    const result = calculateRiskScore(
      makeProfile({ sentThisWeek: 1 }),  // lastSentAt=null → cooldown=0
      makeRule({ max_per_week: 2 }),
    )
    expect(result.decision).toBe('ALLOW')
    expect(result.riskScore).toBeLessThanOrEqual(30)
  })

  it('DELAY con reglas VIP: score ~39 → DELAY (score 31-60)', () => {
    // Reglas VIP: max_per_day=3, max_per_week=7, min_hours=12
    // Perfil: sentToday=1, sentThisWeek=3, hoursSinceLastSend=14h (superó el cooldown de 12h)
    //
    // daily:    40 × (1/3) = 13.33
    // weekly:   35 × (3/7) = 15.00
    // cooldown: ventana=24, ratio=14/24=0.583, score=25×0.417 ≈ 10.42
    // Total:    ≈38.75 → Math.round(38.75) = 39 → DELAY
    const result = calculateRiskScore(
      makeProfile({ sentToday: 1, sentThisWeek: 3, hoursSinceLastSend: 14 }),
      makeRule({ max_per_day: 3, max_per_week: 7, min_hours_between_sends: 12 }),
    )
    expect(result.decision).toBe('DELAY')
    expect(result.riskScore).toBeGreaterThan(30)
    expect(result.riskScore).toBeLessThanOrEqual(60)
  })

  it('reason contiene información útil en ALLOW', () => {
    const result = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 0 }),
      makeRule(),
    )
    expect(result.reason).toContain('Score')
    expect(result.reason).toContain('0/1 hoy')
    expect(result.reason).toContain('0/2 esta semana')
    expect(result.reason).toContain('primer envío')
  })

  it('reason contiene horas desde último envío cuando disponibles', () => {
    const result = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 0, hoursSinceLastSend: 72.3 }),
      makeRule(),
    )
    expect(result.reason).toContain('72.3h')
  })

  it('reason DELAY es descriptiva', () => {
    const result = calculateRiskScore(
      makeProfile({ sentToday: 1, sentThisWeek: 3, hoursSinceLastSend: 14 }),
      makeRule({ max_per_day: 3, max_per_week: 7, min_hours_between_sends: 12 }),
    )
    expect(result.reason).toContain('Score')
    expect(result.reason).toContain('riesgo moderado')
  })

})

// ── Reglas especiales ─────────────────────────────────────────────────────────

describe('calculateRiskScore — reglas especiales', () => {

  it('max_per_day = 5, max_per_week = 10: límites más permisivos no bloquean', () => {
    const result = calculateRiskScore(
      makeProfile({ sentToday: 2, sentThisWeek: 5 }),
      makeRule({ max_per_day: 5, max_per_week: 10, min_hours_between_sends: 0 }),
    )
    expect(result.decision).not.toBe('BLOCK')
  })

  it('riskScore siempre es entero (Math.round aplicado)', () => {
    const result = calculateRiskScore(
      makeProfile({ sentThisWeek: 1 }),
      makeRule({ max_per_week: 2 }),
    )
    expect(Number.isInteger(result.riskScore)).toBe(true)
  })

  it('min_hours=0 con historial reciente → cooldown no aporta al score', () => {
    const { components } = calculateRiskScore(
      makeProfile({ sentToday: 0, sentThisWeek: 1, hoursSinceLastSend: 1 }),
      makeRule({ min_hours_between_sends: 0 }),
    )
    expect(components.cooldownScore).toBe(0)
  })

})
