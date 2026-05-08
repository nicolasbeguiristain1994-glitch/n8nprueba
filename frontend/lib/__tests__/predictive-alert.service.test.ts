/**
 * predictive-alert.service.test.ts
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest'
import {
  PredictiveAlertService,
  type AlertLineInput,
  type DetectedAlert,
} from '@/lib/services/warming/predictive-alert.service'

const svc = new PredictiveAlertService()

function buildInput(overrides: Partial<AlertLineInput> = {}): AlertLineInput {
  return {
    lineId:               'test-line',
    warmup_status:        'active',
    health_score:         70,
    daysSinceLastMessage: 0,
    recent7days:          [],
    recentHistory:        [],
    ...overrides,
  }
}

function days(n: number, sent = 5, failed = 0) {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-05-0${i + 1}`, sent, failed,
  }))
}

function history(scores: number[]) {
  return scores.map(score => ({ score, recordedAt: new Date().toISOString() }))
}

// ── Estados terminales ────────────────────────────────────────────────────────

describe('PredictiveAlertService — estados terminales', () => {
  it('completed → sin alertas', () => {
    const result = svc.detectAlerts(buildInput({ warmup_status: 'completed' }))
    expect(result).toHaveLength(0)
  })

  it('banned → sin alertas', () => {
    const result = svc.detectAlerts(buildInput({ warmup_status: 'banned' }))
    expect(result).toHaveLength(0)
  })
})

// ── ban_risk ──────────────────────────────────────────────────────────────────

describe('PredictiveAlertService — ban_risk', () => {
  it('score ≤ 20 → critical', () => {
    const result = svc.detectAlerts(buildInput({ health_score: 15 }))
    const alert  = result.find(a => a.type === 'ban_risk')
    expect(alert?.severity).toBe('critical')
  })

  it('score 20 (límite) → critical', () => {
    const alert = svc.detectAlerts(buildInput({ health_score: 20 })).find(a => a.type === 'ban_risk')
    expect(alert?.severity).toBe('critical')
  })

  it('score 35 con caída > 10 pts → high', () => {
    const result = svc.detectAlerts(buildInput({
      health_score:  35,
      recentHistory: history([35, 50]),  // delta = -15
    }))
    const alert = result.find(a => a.type === 'ban_risk')
    expect(alert?.severity).toBe('high')
  })

  it('score 45 + caída + fallos > 20% → medium', () => {
    const result = svc.detectAlerts(buildInput({
      health_score:  45,
      recentHistory: history([45, 52]),  // delta = -7
      recent7days:   days(5, 7, 3),     // fail rate = 30%
    }))
    const alert = result.find(a => a.type === 'ban_risk')
    expect(alert?.severity).toBe('medium')
  })

  it('score alto sin tendencia negativa → sin ban_risk', () => {
    const result = svc.detectAlerts(buildInput({ health_score: 75, recentHistory: history([75, 70]) }))
    expect(result.find(a => a.type === 'ban_risk')).toBeUndefined()
  })

  it('línea pausada → sin ban_risk (solo activas)', () => {
    const result = svc.detectAlerts(buildInput({ warmup_status: 'paused', health_score: 10 }))
    expect(result.find(a => a.type === 'ban_risk')).toBeUndefined()
  })
})

// ── inactivity ────────────────────────────────────────────────────────────────

describe('PredictiveAlertService — inactivity', () => {
  it('> 7 días inactiva → critical', () => {
    const result = svc.detectAlerts(buildInput({ daysSinceLastMessage: 8 }))
    const alert  = result.find(a => a.type === 'inactivity')
    expect(alert?.severity).toBe('critical')
  })

  it('7 días exactos → critical', () => {
    const alert = svc.detectAlerts(buildInput({ daysSinceLastMessage: 7 })).find(a => a.type === 'inactivity')
    expect(alert?.severity).toBe('critical')
  })

  it('5 días inactiva → high', () => {
    const result = svc.detectAlerts(buildInput({ daysSinceLastMessage: 5 }))
    const alert  = result.find(a => a.type === 'inactivity')
    expect(alert?.severity).toBe('high')
  })

  it('3 días inactiva → sin alerta (debajo del umbral)', () => {
    const result = svc.detectAlerts(buildInput({ daysSinceLastMessage: 3 }))
    expect(result.find(a => a.type === 'inactivity')).toBeUndefined()
  })

  it('línea pausada → sin alerta de inactividad', () => {
    const result = svc.detectAlerts(buildInput({ warmup_status: 'paused', daysSinceLastMessage: 10 }))
    expect(result.find(a => a.type === 'inactivity')).toBeUndefined()
  })
})

// ── health_drop ───────────────────────────────────────────────────────────────

describe('PredictiveAlertService — health_drop', () => {
  it('caída ≥ 30 pts en 48h → critical', () => {
    // history: [actual=40, 24h=55, 48h=72]  → 72-40 = 32 drop
    const result = svc.detectAlerts(buildInput({ recentHistory: history([40, 55, 72]) }))
    const alert  = result.find(a => a.type === 'health_drop')
    expect(alert?.severity).toBe('critical')
  })

  it('caída ≥ 25 pts en 48h → high', () => {
    // [50, 63, 75]  → 75-50 = 25 drop
    const result = svc.detectAlerts(buildInput({ recentHistory: history([50, 63, 75]) }))
    const alert  = result.find(a => a.type === 'health_drop')
    expect(alert?.severity).toBe('high')
  })

  it('caída ≥ 20 pts en 24h (solo 2 puntos) → medium', () => {
    // [45, 65]  → 65-45 = 20 drop en 24h
    const result = svc.detectAlerts(buildInput({ recentHistory: history([45, 65]) }))
    const alert  = result.find(a => a.type === 'health_drop')
    expect(alert?.severity).toBe('medium')
  })

  it('caída pequeña → sin alerta', () => {
    const result = svc.detectAlerts(buildInput({ recentHistory: history([70, 75]) }))
    expect(result.find(a => a.type === 'health_drop')).toBeUndefined()
  })

  it('historial con 1 solo punto → sin alerta', () => {
    const result = svc.detectAlerts(buildInput({ recentHistory: history([50]) }))
    expect(result.find(a => a.type === 'health_drop')).toBeUndefined()
  })
})

// ── high_failure_rate ─────────────────────────────────────────────────────────

describe('PredictiveAlertService — high_failure_rate', () => {
  it('tasa > 50% con ≥ 5 mensajes → critical', () => {
    const result = svc.detectAlerts(buildInput({ recent7days: days(5, 4, 6) }))  // 6/10 = 60%
    const alert  = result.find(a => a.type === 'high_failure_rate')
    expect(alert?.severity).toBe('critical')
  })

  it('tasa > 30% → high', () => {
    const result = svc.detectAlerts(buildInput({ recent7days: days(5, 6, 4) }))  // 4/10 = 40%
    const alert  = result.find(a => a.type === 'high_failure_rate')
    expect(alert?.severity).toBe('high')
  })

  it('tasa > 15% con ≥ 10 mensajes → medium', () => {
    // 2 failed of 10 total = 20%
    const result = svc.detectAlerts(buildInput({
      recent7days: Array.from({ length: 5 }, () => ({ date: '2026-05-01', sent: 8, failed: 2 })),
    }))
    const alert = result.find(a => a.type === 'high_failure_rate')
    expect(alert?.severity).toBe('medium')
  })

  it('< 5 mensajes en total → sin alerta (no significativo)', () => {
    const result = svc.detectAlerts(buildInput({ recent7days: [{ date: '2026-05-01', sent: 1, failed: 3 }] }))
    expect(result.find(a => a.type === 'high_failure_rate')).toBeUndefined()
  })

  it('tasa 0% → sin alerta', () => {
    const result = svc.detectAlerts(buildInput({ recent7days: days(7, 10, 0) }))
    expect(result.find(a => a.type === 'high_failure_rate')).toBeUndefined()
  })
})

// ── Múltiples alertas simultáneas ─────────────────────────────────────────────

describe('PredictiveAlertService — alertas múltiples', () => {
  it('línea con varios problemas devuelve alertas múltiples', () => {
    const result = svc.detectAlerts(buildInput({
      health_score:         15,  // ban_risk critical
      daysSinceLastMessage: 8,   // inactivity critical
      recent7days:          days(5, 3, 7),  // failure_rate critical
    }))
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result.some(a => a.type === 'ban_risk')).toBe(true)
    // inactivity no aplica en "ban_risk" porque son detectores independientes
  })

  it('todas las alertas tienen type y severity válidos', () => {
    const result = svc.detectAlerts(buildInput({ health_score: 15, daysSinceLastMessage: 5 }))
    for (const a of result) {
      expect(['ban_risk', 'inactivity', 'health_drop', 'high_failure_rate']).toContain(a.type)
      expect(['low', 'medium', 'high', 'critical']).toContain(a.severity)
    }
  })
})
