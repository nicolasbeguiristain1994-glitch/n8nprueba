/**
 * health-calculator.service.test.ts
 * @vitest-environment node
 *
 * Tests unitarios para HealthCalculatorService.
 * No requiere conexión a DB — el servicio es puro.
 *
 * Cambios respecto a v1:
 *   - HealthInput.daily_limit     → effectiveDailyLimit  (pre-calculado)
 *   - HealthInput.last_message_at → daysSinceLastMessage (pre-calculado; 0 = sin historial)
 */

import { describe, it, expect } from 'vitest'
import { getDailyLimitForDay } from '@/lib/warmup-engine'
import {
  HealthCalculatorService,
  type HealthInput,
  type DailyStats,
} from '@/lib/services/warming/health-calculator.service'

// ── Factory helpers ────────────────────────────────────────────────────────────

function buildInput(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    warmup_status:        'active',
    current_day:          7,
    target_days:          21,
    effectiveDailyLimit:  getDailyLimitForDay(7, 21), // ≈ 33
    messages_sent_today:  5,
    daysSinceLastMessage: 0,
    recent7days:          [],
    ...overrides,
  }
}

function activeDays(n: number): DailyStats[] {
  return Array.from({ length: n }, (_, i) => ({
    date:   `2026-05-0${i + 1}`,
    sent:   5,
    failed: 0,
  }))
}

const svc = new HealthCalculatorService()

// ── Tests de estado terminal ──────────────────────────────────────────────────

describe('HealthCalculatorService — estados terminales', () => {
  it('banned → score 0 y label Baneada', () => {
    const result = svc.calculate(buildInput({ warmup_status: 'banned' }))
    expect(result.score).toBe(0)
    expect(result.label).toBe('Baneada')
    expect(result.components.progressScore).toBe(0)
  })

  it('completed → score 100 y label Óptima', () => {
    const result = svc.calculate(buildInput({ warmup_status: 'completed' }))
    expect(result.score).toBe(100)
    expect(result.label).toBe('Óptima')
    expect(result.recommendation).toContain('lista para producción')
  })
})

// ── Tests de score activo ─────────────────────────────────────────────────────

describe('HealthCalculatorService — línea activa', () => {
  it('score dentro de rango [0, 100]', () => {
    const result = svc.calculate(buildInput())
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
  })

  it('línea nueva (día 1, sin historial) tiene score base ≥ 30', () => {
    const result = svc.calculate(buildInput({
      current_day:          1,
      target_days:          21,
      effectiveDailyLimit:  getDailyLimitForDay(1, 21),
      messages_sent_today:  0,
      daysSinceLastMessage: 0,
      recent7days:          [],
    }))
    // base=30, progress=round(1/21*30)=1, trend=0, activity=0 → 31
    expect(result.score).toBeGreaterThanOrEqual(30)
    expect(result.components.base).toBe(30)
    expect(result.components.trendScore).toBe(0)
    expect(result.components.inactivityPenalty).toBe(0)
  })

  it('línea completa (día 21/21) con 7 días activos tiene score muy alto', () => {
    // getDailyLimitForDay(21, 21) = 63 → messages_sent_today=63 → activityScore=20
    const effectiveDailyLimit = getDailyLimitForDay(21, 21)
    const result = svc.calculate(buildInput({
      current_day:          21,
      target_days:          21,
      effectiveDailyLimit,
      messages_sent_today:  effectiveDailyLimit,
      daysSinceLastMessage: 0,
      recent7days:          activeDays(7),
    }))
    // base=30, progress=30, trend=20, activity=20 → 100
    expect(result.score).toBe(100)
    expect(result.label).toBe('Óptima')
    expect(result.components.progressScore).toBe(30)
    expect(result.components.trendScore).toBe(20)
    expect(result.components.activityScore).toBe(20)
  })

  it('progressScore escala linealmente con el avance', () => {
    const mid  = svc.calculate(buildInput({ current_day: 10, target_days: 20, messages_sent_today: 0, daysSinceLastMessage: 0, recent7days: [] }))
    const full = svc.calculate(buildInput({ current_day: 20, target_days: 20, messages_sent_today: 0, daysSinceLastMessage: 0, recent7days: [] }))
    expect(full.components.progressScore).toBeGreaterThan(mid.components.progressScore)
    expect(full.components.progressScore).toBe(30) // máximo
  })

  it('activityScore es proporcional a mensajes enviados / cuota efectiva', () => {
    // effectiveDailyLimit = getDailyLimitForDay(7, 21) ≈ 33
    // Con 0 enviados: score=0; con cuota llena (≥ limit): score=20 (cap)
    const low  = svc.calculate(buildInput({ messages_sent_today: 0 }))
    const high = svc.calculate(buildInput({ messages_sent_today: 100 })) // supera cualquier cuota
    expect(high.components.activityScore).toBeGreaterThan(low.components.activityScore)
    expect(high.components.activityScore).toBe(20) // cap at MAX_ACTIVITY
    expect(low.components.activityScore).toBe(0)
  })

  it('trendScore refleja días activos en los últimos 7', () => {
    const noTrend  = svc.calculate(buildInput({ recent7days: [] }))
    const maxTrend = svc.calculate(buildInput({ recent7days: activeDays(7) }))
    expect(maxTrend.components.trendScore).toBe(20)
    expect(noTrend.components.trendScore).toBe(0)
  })

  it('trendScore cuenta días con sent > 0', () => {
    const mixed: DailyStats[] = [
      { date: '2026-05-01', sent: 3, failed: 0 },
      { date: '2026-05-02', sent: 0, failed: 2 }, // fallido pero sin envíos
      { date: '2026-05-03', sent: 5, failed: 1 },
    ]
    const result = svc.calculate(buildInput({ recent7days: mixed }))
    // 2 días activos de 7 → round(2/7 * 20) = round(5.7) = 6
    expect(result.components.trendScore).toBe(6)
  })
})

// ── Tests de penalidades ──────────────────────────────────────────────────────

describe('HealthCalculatorService — penalidades', () => {
  it('inactivityPenalty = 0 si daysSinceLastMessage ≤ 2 días', () => {
    const result = svc.calculate(buildInput({ daysSinceLastMessage: 1 }))
    expect(result.components.inactivityPenalty).toBe(0)
  })

  it('inactivityPenalty crece con días de inactividad (>2 días)', () => {
    const r3 = svc.calculate(buildInput({ daysSinceLastMessage: 3 }))
    const r6 = svc.calculate(buildInput({ daysSinceLastMessage: 6 }))
    expect(r6.components.inactivityPenalty).toBeGreaterThan(r3.components.inactivityPenalty)
  })

  it('inactivityPenalty tiene tope de 30', () => {
    const result = svc.calculate(buildInput({ daysSinceLastMessage: 100 }))
    expect(result.components.inactivityPenalty).toBe(30)
  })

  it('inactivityPenalty = 0 si daysSinceLastMessage = 0 (sin historial)', () => {
    const result = svc.calculate(buildInput({ daysSinceLastMessage: 0 }))
    expect(result.components.inactivityPenalty).toBe(0)
  })

  it('failurePenalty = 0 sin historial de envíos', () => {
    const result = svc.calculate(buildInput({ recent7days: [] }))
    expect(result.components.failurePenalty).toBe(0)
  })

  it('failurePenalty máximo cuando todos los mensajes fallan', () => {
    const allFailed: DailyStats[] = [{ date: '2026-05-01', sent: 0, failed: 10 }]
    const result = svc.calculate(buildInput({ recent7days: allFailed }))
    expect(result.components.failurePenalty).toBe(20)
  })

  it('failurePenalty proporcional a la tasa de fallos', () => {
    const half: DailyStats[] = [{ date: '2026-05-01', sent: 5, failed: 5 }]
    const result = svc.calculate(buildInput({ recent7days: half }))
    expect(result.components.failurePenalty).toBe(10)
  })
})

// ── Tests de estado pausado ───────────────────────────────────────────────────

describe('HealthCalculatorService — línea pausada', () => {
  it('score máximo para pausado es 40', () => {
    const result = svc.calculate(buildInput({
      warmup_status:       'paused',
      current_day:         21,
      target_days:         21,
      recent7days:         activeDays(7),
      messages_sent_today: 10,
    }))
    expect(result.score).toBeLessThanOrEqual(40)
  })

  it('score no puede ser negativo', () => {
    const result = svc.calculate(buildInput({
      warmup_status:        'paused',
      daysSinceLastMessage: 100,
      recent7days: [{ date: '2026-05-01', sent: 0, failed: 10 }],
    }))
    expect(result.score).toBeGreaterThanOrEqual(0)
  })
})

// ── Tests de labels y colores ─────────────────────────────────────────────────

describe('HealthCalculatorService — label y color', () => {
  const cases: Array<[number, string, string]> = [
    [  0, 'Baneada',  'bg-red-500'    ],
    [ 20, 'Crítico',  'bg-orange-400' ],
    [ 50, 'Regular',  'bg-amber-400'  ],
    [ 70, 'Buena',    'bg-lime-500'   ],
    [ 90, 'Óptima',   'bg-green-500'  ],
  ]

  for (const [score, expectedLabel, expectedColor] of cases) {
    it(`score ${score} → label "${expectedLabel}"`, () => {
      expect(svc.label(score)).toBe(expectedLabel)
    })
    it(`score ${score} → color "${expectedColor}"`, () => {
      expect(svc.color(score)).toBe(expectedColor)
    })
  }
})
