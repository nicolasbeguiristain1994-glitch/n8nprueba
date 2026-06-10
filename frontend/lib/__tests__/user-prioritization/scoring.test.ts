// @vitest-environment node
import { describe, it, expect } from 'vitest'

import {
  resolveValueTier,
  scoreValue,
  scoreUrgency,
  resolveReactivationSegment,
  computeScore,
} from '@/lib/user-prioritization/scoring'
import {
  INACTIVITY_WINDOWS,
  VALUE_SCORES,
  RECONTACT_COOLDOWN_DAYS,
} from '@/lib/user-prioritization/config'

// ── resolveValueTier ──────────────────────────────────────────────────────────

describe('resolveValueTier', () => {
  describe('cuando hay monto disponible, prioriza monto sobre segment', () => {
    it('asigna super_vip si monto >= 3.200.000', () => {
      expect(resolveValueTier('bajo', 3_200_000)).toBe('super_vip')
      expect(resolveValueTier(null,   5_000_000)).toBe('super_vip')
    })

    it('asigna vip_alto si monto entre 1.500.000 y 3.199.999', () => {
      expect(resolveValueTier('bajo', 1_500_000)).toBe('vip_alto')
      expect(resolveValueTier('bajo', 3_199_999)).toBe('vip_alto')
    })

    it('asigna vip_medio si monto entre 1.000.000 y 1.499.999', () => {
      expect(resolveValueTier(null,   1_000_000)).toBe('vip_medio')
      expect(resolveValueTier('bajo', 1_499_999)).toBe('vip_medio')
    })

    it('asigna vip si monto entre 500.000 y 999.999', () => {
      expect(resolveValueTier('bajo', 500_000)).toBe('vip')
      expect(resolveValueTier(null,   999_999)).toBe('vip')
    })

    it('asigna medio si monto entre 100.000 y 499.999', () => {
      expect(resolveValueTier(null,   100_000)).toBe('medio')
      expect(resolveValueTier('vip',  499_999)).toBe('medio')
    })

    it('asigna bajo si monto < 100.000', () => {
      expect(resolveValueTier('vip', 0)).toBe('bajo')
      expect(resolveValueTier(null,  99_999)).toBe('bajo')
    })
  })

  describe('sin monto (NULL), usa segment como fallback', () => {
    it('mapea segmentos conocidos correctamente', () => {
      expect(resolveValueTier('super_vip', null)).toBe('super_vip')
      expect(resolveValueTier('vip_alto',  null)).toBe('vip_alto')
      expect(resolveValueTier('vip_medio', null)).toBe('vip_medio')
      expect(resolveValueTier('vip',       null)).toBe('vip')
      expect(resolveValueTier('medio',     null)).toBe('medio')
      expect(resolveValueTier('bajo',      null)).toBe('bajo')
    })

    it('trata null y segmentos legacy como bajo (conservador)', () => {
      expect(resolveValueTier(null,     null)).toBe('bajo')
      expect(resolveValueTier('casual', null)).toBe('bajo')
      expect(resolveValueTier('whale',  null)).toBe('bajo')
    })
  })
})

// ── scoreValue ────────────────────────────────────────────────────────────────

describe('scoreValue', () => {
  it('super_vip obtiene el máximo (60)',  () => expect(scoreValue('super_vip')).toBe(60))
  it('vip_alto obtiene 56',              () => expect(scoreValue('vip_alto')).toBe(56))
  it('vip_medio obtiene 52',             () => expect(scoreValue('vip_medio')).toBe(52))
  it('vip obtiene 45',                   () => expect(scoreValue('vip')).toBe(45))
  it('medio obtiene 25',                 () => expect(scoreValue('medio')).toBe(25))
  it('bajo obtiene 10',                  () => expect(scoreValue('bajo')).toBe(10))

  it('VIP siempre supera a BAJO independiente del urgencyScore (45+0 > 10+40)', () => {
    expect(scoreValue('vip') + 0).toBeGreaterThan(scoreValue('bajo') + 40)
  })
})

// ── scoreUrgency ──────────────────────────────────────────────────────────────

describe('scoreUrgency', () => {
  // Ventana super_vip: 7–180 días, span = 173
  describe('tier super_vip (ventana 7–180 días)', () => {
    it('inicio de ventana (7 días) → urgencia máxima (40)', () => {
      expect(scoreUrgency(7, 'super_vip')).toBe(40)
    })

    it('día 120 → tiene urgencia positiva — sigue en la lista', () => {
      expect(scoreUrgency(120, 'super_vip')).toBeGreaterThan(0)
    })

    it('fin de ventana (180 días) → urgencyScore = 0 pero contacto sigue en lista', () => {
      expect(scoreUrgency(180, 'super_vip')).toBe(0)
    })

    it('decae monotónicamente dentro de la ventana', () => {
      expect(scoreUrgency(7,   'super_vip')).toBeGreaterThan(scoreUrgency(60,  'super_vip'))
      expect(scoreUrgency(60,  'super_vip')).toBeGreaterThan(scoreUrgency(120, 'super_vip'))
      expect(scoreUrgency(120, 'super_vip')).toBeGreaterThan(scoreUrgency(180, 'super_vip'))
    })
  })

  // Ventana VIP Bajo: 7–150 días, span = 143
  describe('tier vip (VIP Bajo, ventana 7–150 días)', () => {
    it('inicio de ventana (7 días) → 40', () => {
      expect(scoreUrgency(7, 'vip')).toBe(40)
    })

    it('día 90 → urgencia positiva', () => {
      expect(scoreUrgency(90, 'vip')).toBeGreaterThan(0)
    })

    it('fin de ventana (150 días) → 0', () => {
      expect(scoreUrgency(150, 'vip')).toBe(0)
    })
  })

  // Ventana BAJO: 30–45 días, span = 15
  describe('tier BAJO (ventana 30–45 días, muy estrecha)', () => {
    it('inicio de ventana (30 días) → 40', () => {
      expect(scoreUrgency(30, 'bajo')).toBe(40)
    })

    it('fin de ventana (45 días) → 0', () => {
      expect(scoreUrgency(45, 'bajo')).toBe(0)
    })
  })

  // Ventana MEDIO: 14–60 días, span = 46
  describe('tier MEDIO (ventana 14–60 días)', () => {
    it('inicio de ventana (14 días) → 40', () => {
      expect(scoreUrgency(14, 'medio')).toBe(40)
    })

    it('fin de ventana (60 días) → 0', () => {
      expect(scoreUrgency(60, 'medio')).toBe(0)
    })
  })
})

// ── resolveReactivationSegment ────────────────────────────────────────────────

describe('resolveReactivationSegment', () => {
  describe('super_vip (ventana 7–180d)', () => {
    it('7–30 días → URGENTE', () => {
      expect(resolveReactivationSegment('super_vip', 7)).toBe('REACTIVACION_URGENTE')
      expect(resolveReactivationSegment('super_vip', 30)).toBe('REACTIVACION_URGENTE')
    })

    it('31–90 días → PRIORITARIA', () => {
      expect(resolveReactivationSegment('super_vip', 31)).toBe('REACTIVACION_PRIORITARIA')
      expect(resolveReactivationSegment('super_vip', 90)).toBe('REACTIVACION_PRIORITARIA')
    })

    it('91–120 días → ESTANDAR', () => {
      expect(resolveReactivationSegment('super_vip', 91)).toBe('REACTIVACION_ESTANDAR')
      expect(resolveReactivationSegment('super_vip', 120)).toBe('REACTIVACION_ESTANDAR')
    })

    it('121–180 días → FRIA_ALTO_VALOR (win-back)', () => {
      expect(resolveReactivationSegment('super_vip', 121)).toBe('REACTIVACION_FRIA_ALTO_VALOR')
      expect(resolveReactivationSegment('super_vip', 180)).toBe('REACTIVACION_FRIA_ALTO_VALOR')
    })

    it('más de 180 días → null (demasiado frío)', () => {
      expect(resolveReactivationSegment('super_vip', 181)).toBeNull()
    })
  })

  describe('vip / vip_medio / vip_alto (ventana 7–150d)', () => {
    it('7–30 días → URGENTE', () => {
      expect(resolveReactivationSegment('vip', 15)).toBe('REACTIVACION_URGENTE')
    })

    it('31–90 días → PRIORITARIA', () => {
      expect(resolveReactivationSegment('vip', 60)).toBe('REACTIVACION_PRIORITARIA')
    })

    it('91–120 días → ESTANDAR', () => {
      expect(resolveReactivationSegment('vip', 100)).toBe('REACTIVACION_ESTANDAR')
    })

    it('121–150 días → FRIA_ALTO_VALOR', () => {
      expect(resolveReactivationSegment('vip', 121)).toBe('REACTIVACION_FRIA_ALTO_VALOR')
      expect(resolveReactivationSegment('vip', 150)).toBe('REACTIVACION_FRIA_ALTO_VALOR')
    })

    it('más de 150 días → null (vip no llega a 6 meses)', () => {
      expect(resolveReactivationSegment('vip', 151)).toBeNull()
    })
  })

  describe('MEDIO (ventana 14–60d)', () => {
    it('14–30 días → PRIORITARIA', () => {
      expect(resolveReactivationSegment('medio', 14)).toBe('REACTIVACION_PRIORITARIA')
      expect(resolveReactivationSegment('medio', 30)).toBe('REACTIVACION_PRIORITARIA')
    })

    it('31–60 días → ESTANDAR', () => {
      expect(resolveReactivationSegment('medio', 31)).toBe('REACTIVACION_ESTANDAR')
      expect(resolveReactivationSegment('medio', 60)).toBe('REACTIVACION_ESTANDAR')
    })

    it('menos de 14 días → null (aún activo para este tier)', () => {
      expect(resolveReactivationSegment('medio', 7)).toBeNull()
      expect(resolveReactivationSegment('medio', 13)).toBeNull()
    })

    it('más de 60 días → null (demasiado frío para MEDIO)', () => {
      expect(resolveReactivationSegment('medio', 61)).toBeNull()
    })
  })

  describe('BAJO (ventana 30–45d, única franja)', () => {
    it('30–45 días → FRIA', () => {
      expect(resolveReactivationSegment('bajo', 30)).toBe('REACTIVACION_FRIA')
      expect(resolveReactivationSegment('bajo', 45)).toBe('REACTIVACION_FRIA')
    })

    it('fuera de la ventana estrecha → null', () => {
      expect(resolveReactivationSegment('bajo', 29)).toBeNull()
      expect(resolveReactivationSegment('bajo', 46)).toBeNull()
    })
  })
})

// ── computeScore — escenarios de negocio ──────────────────────────────────────

describe('computeScore — escenarios de negocio', () => {
  it('super_vip recién inactivo (7 días) → score máximo (100), URGENTE', () => {
    const r = computeScore({ daysInactive: 7, segment: 'super_vip', totalDepositAmount: null })
    expect(r.valueScore).toBe(60)
    expect(r.urgencyScore).toBe(40)
    expect(r.total).toBe(100)
    expect(r.reactivationSegment).toBe('REACTIVACION_URGENTE')
  })

  it('super_vip al final de su ventana (180 días) → urgencyScore=0, score=60, sigue en lista', () => {
    const r = computeScore({ daysInactive: 180, segment: 'super_vip', totalDepositAmount: null })
    expect(r.urgencyScore).toBe(0)
    expect(r.valueScore).toBe(60)
    expect(r.total).toBe(60)
    expect(r.reactivationSegment).toBe('REACTIVACION_FRIA_ALTO_VALOR')
  })

  it('super_vip 181 días → fuera de ventana, segment null', () => {
    const r = computeScore({ daysInactive: 181, segment: 'super_vip', totalDepositAmount: null })
    expect(r.reactivationSegment).toBeNull()
  })

  it('vip inactivo 130 días → FRIA_ALTO_VALOR', () => {
    const r = computeScore({ daysInactive: 130, segment: 'vip', totalDepositAmount: null })
    expect(r.reactivationSegment).toBe('REACTIVACION_FRIA_ALTO_VALOR')
    expect(r.valueTier).toBe('vip')
  })

  it('vip inactivo 20 días → URGENTE con score > 70', () => {
    const r = computeScore({ daysInactive: 20, segment: 'vip', totalDepositAmount: null })
    expect(r.reactivationSegment).toBe('REACTIVACION_URGENTE')
    expect(r.total).toBeGreaterThan(70)
  })

  it('propiedad clave: super_vip fin de ventana (score=60) > BAJO inicio de ventana (score=50)', () => {
    const svipFin = computeScore({ daysInactive: 180, segment: 'super_vip', totalDepositAmount: null })
    const bajoComienzo = computeScore({ daysInactive: 30, segment: 'bajo', totalDepositAmount: null })
    expect(svipFin.total).toBeGreaterThan(bajoComienzo.total)
  })

  it('score decae monotónicamente para el mismo tier', () => {
    const a = computeScore({ daysInactive: 7,   segment: 'super_vip', totalDepositAmount: null })
    const b = computeScore({ daysInactive: 60,  segment: 'super_vip', totalDepositAmount: null })
    const c = computeScore({ daysInactive: 120, segment: 'super_vip', totalDepositAmount: null })
    const d = computeScore({ daysInactive: 160, segment: 'super_vip', totalDepositAmount: null })
    expect(a.total).toBeGreaterThan(b.total)
    expect(b.total).toBeGreaterThan(c.total)
    expect(c.total).toBeGreaterThan(d.total)
  })

  it('monto disponible overridea segment para el tier', () => {
    const r = computeScore({ daysInactive: 10, segment: 'bajo', totalDepositAmount: 3_200_000 })
    expect(r.valueTier).toBe('super_vip')
    expect(r.valueScore).toBe(60)
    expect(r.reactivationSegment).toBe('REACTIVACION_URGENTE')
  })

  it('MEDIO inactivo 45 días → ESTANDAR', () => {
    const r = computeScore({ daysInactive: 45, segment: 'medio', totalDepositAmount: null })
    expect(r.reactivationSegment).toBe('REACTIVACION_ESTANDAR')
  })

  it('BAJO inactivo 37 días → FRIA con score total bajo', () => {
    const r = computeScore({ daysInactive: 37, segment: 'bajo', totalDepositAmount: null })
    expect(r.reactivationSegment).toBe('REACTIVACION_FRIA')
    expect(r.valueScore).toBe(10)
    expect(r.total).toBeLessThan(50)
  })
})

// ── Propiedades de configuración ──────────────────────────────────────────────

describe('Consistencia de configuración', () => {
  it('todos los tiers tienen ventana de inactividad definida y válida', () => {
    for (const tier of ['super_vip', 'vip_alto', 'vip_medio', 'vip', 'medio', 'bajo'] as const) {
      expect(INACTIVITY_WINDOWS[tier].minDays).toBeGreaterThan(0)
      expect(INACTIVITY_WINDOWS[tier].maxDays).toBeGreaterThan(INACTIVITY_WINDOWS[tier].minDays)
    }
  })

  it('VALUE_SCORES garantizan que vip+0 > bajo+40 (orden inter-tier preservado)', () => {
    expect(VALUE_SCORES.vip + 0).toBeGreaterThan(VALUE_SCORES.bajo + 40)
  })

  it('VALUE_SCORES están ordenados: super_vip > vip_alto > vip_medio > vip > medio > bajo', () => {
    expect(VALUE_SCORES.super_vip).toBeGreaterThan(VALUE_SCORES.vip_alto)
    expect(VALUE_SCORES.vip_alto).toBeGreaterThan(VALUE_SCORES.vip_medio)
    expect(VALUE_SCORES.vip_medio).toBeGreaterThan(VALUE_SCORES.vip)
    expect(VALUE_SCORES.vip).toBeGreaterThan(VALUE_SCORES.medio)
    expect(VALUE_SCORES.medio).toBeGreaterThan(VALUE_SCORES.bajo)
  })

  it('cooldowns de recontacto son más largos para tiers de menor valor', () => {
    expect(RECONTACT_COOLDOWN_DAYS.bajo).toBeGreaterThan(RECONTACT_COOLDOWN_DAYS.vip)
    expect(RECONTACT_COOLDOWN_DAYS.medio).toBeGreaterThan(RECONTACT_COOLDOWN_DAYS.vip_medio)
  })

  it('super_vip tiene la ventana más larga (mayor LTV justifica más intentos)', () => {
    expect(INACTIVITY_WINDOWS.super_vip.maxDays).toBeGreaterThan(INACTIVITY_WINDOWS.vip_alto.maxDays)
    expect(INACTIVITY_WINDOWS.vip_alto.maxDays).toBeGreaterThan(INACTIVITY_WINDOWS.vip.maxDays)
    expect(INACTIVITY_WINDOWS.vip.maxDays).toBeGreaterThan(INACTIVITY_WINDOWS.medio.maxDays)
  })
})
