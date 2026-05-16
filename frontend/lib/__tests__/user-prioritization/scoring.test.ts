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
    it('asigna vip si monto >= 10000', () => {
      expect(resolveValueTier('bajo', 10_000)).toBe('vip')
      expect(resolveValueTier(null, 50_000)).toBe('vip')
    })

    it('asigna alto si monto entre 3000 y 9999', () => {
      expect(resolveValueTier('bajo', 3_000)).toBe('alto')
      expect(resolveValueTier('vip', 5_000)).toBe('alto')  // monto gana al segment
    })

    it('asigna medio si monto entre 500 y 2999', () => {
      expect(resolveValueTier(null, 500)).toBe('medio')
      expect(resolveValueTier('vip', 2_999)).toBe('medio') // monto overridea vip
    })

    it('asigna bajo si monto < 500', () => {
      expect(resolveValueTier('vip', 0)).toBe('bajo')
      expect(resolveValueTier(null, 499)).toBe('bajo')
    })
  })

  describe('sin monto (NULL), usa segment como fallback', () => {
    it('mapea segmentos conocidos correctamente', () => {
      expect(resolveValueTier('vip',   null)).toBe('vip')
      expect(resolveValueTier('alto',  null)).toBe('alto')
      expect(resolveValueTier('medio', null)).toBe('medio')
      expect(resolveValueTier('bajo',  null)).toBe('bajo')
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
  it('VIP obtiene el máximo (60)', () => expect(scoreValue('vip')).toBe(60))
  it('alto obtiene 45',          () => expect(scoreValue('alto')).toBe(45))
  it('medio obtiene 25',         () => expect(scoreValue('medio')).toBe(25))
  it('bajo obtiene 10',          () => expect(scoreValue('bajo')).toBe(10))

  it('VIP siempre supera a BAJO independiente del urgencyScore (60+0 > 10+40)', () => {
    // Esto garantiza que el orden inter-tier es correcto
    expect(scoreValue('vip') + 0).toBeGreaterThan(scoreValue('bajo') + 40)
  })
})

// ── scoreUrgency ──────────────────────────────────────────────────────────────

describe('scoreUrgency', () => {
  // Ventana VIP: 7–180 días, span = 173
  describe('tier VIP (ventana 7–180 días)', () => {
    it('inicio de ventana (7 días) → urgencia máxima (40)', () => {
      expect(scoreUrgency(7, 'vip')).toBe(40)
    })

    it('día 63 → 27 (posición ~32% en la ventana)', () => {
      // position = (63-7)/173 = 0.324, urgency = round(0.676*40) = 27
      expect(scoreUrgency(63, 'vip')).toBe(27)
    })

    it('día 120 (antiguo límite) → 14, NO cero — sigue en la lista', () => {
      // La ventana se extendió a 180 días. Un VIP al día 120 aún tiene urgencia.
      // position = (120-7)/173 = 0.653, urgency = round(0.347*40) = 14
      expect(scoreUrgency(120, 'vip')).toBe(14)
    })

    it('día 150 → 7 (urgencia baja pero no cero)', () => {
      // position = (150-7)/173 = 0.827, urgency = round(0.173*40) = 7
      expect(scoreUrgency(150, 'vip')).toBe(7)
    })

    it('fin de ventana (180 días) → urgencyScore = 0 pero contacto sigue en lista', () => {
      // urgencyScore = 0 ≠ exclusión. Score total = 60 + 0 = 60.
      // Esto representa la "última oportunidad" para un VIP.
      expect(scoreUrgency(180, 'vip')).toBe(0)
    })

    it('decae monotónicamente dentro de la ventana', () => {
      expect(scoreUrgency(7,   'vip')).toBeGreaterThan(scoreUrgency(60,  'vip'))
      expect(scoreUrgency(60,  'vip')).toBeGreaterThan(scoreUrgency(120, 'vip'))
      expect(scoreUrgency(120, 'vip')).toBeGreaterThan(scoreUrgency(180, 'vip'))
    })
  })

  // Ventana ALTO: 7–150 días, span = 143
  describe('tier ALTO (ventana 7–150 días)', () => {
    it('inicio de ventana (7 días) → 40', () => {
      expect(scoreUrgency(7, 'alto')).toBe(40)
    })

    it('día 90 → 17', () => {
      // position = 83/143 = 0.580, urgency = round(0.420*40) = 17
      expect(scoreUrgency(90, 'alto')).toBe(17)
    })

    it('fin de ventana (150 días) → 0', () => {
      expect(scoreUrgency(150, 'alto')).toBe(0)
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
  describe('VIP (ventana 7–180d, 5 rangos)', () => {
    it('7–30 días → URGENTE', () => {
      expect(resolveReactivationSegment('vip', 7)).toBe('REACTIVACION_URGENTE')
      expect(resolveReactivationSegment('vip', 30)).toBe('REACTIVACION_URGENTE')
    })

    it('31–90 días → PRIORITARIA', () => {
      expect(resolveReactivationSegment('vip', 31)).toBe('REACTIVACION_PRIORITARIA')
      expect(resolveReactivationSegment('vip', 90)).toBe('REACTIVACION_PRIORITARIA')
    })

    it('91–120 días → ESTANDAR', () => {
      expect(resolveReactivationSegment('vip', 91)).toBe('REACTIVACION_ESTANDAR')
      expect(resolveReactivationSegment('vip', 120)).toBe('REACTIVACION_ESTANDAR')
    })

    it('121–180 días → FRIA_ALTO_VALOR (win-back)', () => {
      expect(resolveReactivationSegment('vip', 121)).toBe('REACTIVACION_FRIA_ALTO_VALOR')
      expect(resolveReactivationSegment('vip', 150)).toBe('REACTIVACION_FRIA_ALTO_VALOR')
      expect(resolveReactivationSegment('vip', 180)).toBe('REACTIVACION_FRIA_ALTO_VALOR')
    })

    it('más de 180 días → null (demasiado frío)', () => {
      expect(resolveReactivationSegment('vip', 181)).toBeNull()
      expect(resolveReactivationSegment('vip', 365)).toBeNull()
    })
  })

  describe('ALTO (ventana 7–150d)', () => {
    it('7–30 días → URGENTE', () => {
      expect(resolveReactivationSegment('alto', 15)).toBe('REACTIVACION_URGENTE')
    })

    it('31–90 días → PRIORITARIA', () => {
      expect(resolveReactivationSegment('alto', 60)).toBe('REACTIVACION_PRIORITARIA')
    })

    it('91–120 días → ESTANDAR', () => {
      expect(resolveReactivationSegment('alto', 100)).toBe('REACTIVACION_ESTANDAR')
    })

    it('121–150 días → FRIA_ALTO_VALOR', () => {
      expect(resolveReactivationSegment('alto', 121)).toBe('REACTIVACION_FRIA_ALTO_VALOR')
      expect(resolveReactivationSegment('alto', 150)).toBe('REACTIVACION_FRIA_ALTO_VALOR')
    })

    it('más de 150 días → null (ALTO no llega a 6 meses, solo VIP)', () => {
      expect(resolveReactivationSegment('alto', 151)).toBeNull()
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
  it('VIP recién inactivo (7 días) → score máximo (100), URGENTE', () => {
    const r = computeScore({ daysInactive: 7, segment: 'vip', totalDepositAmount: null })
    expect(r.valueScore).toBe(60)
    expect(r.urgencyScore).toBe(40)
    expect(r.total).toBe(100)
    expect(r.reactivationSegment).toBe('REACTIVACION_URGENTE')
  })

  it('VIP inactivo 150 días → FRIA_ALTO_VALOR, score=67', () => {
    const r = computeScore({ daysInactive: 150, segment: 'vip', totalDepositAmount: null })
    expect(r.reactivationSegment).toBe('REACTIVACION_FRIA_ALTO_VALOR')
    expect(r.valueScore).toBe(60)
    expect(r.urgencyScore).toBe(7)
    expect(r.total).toBe(67)
  })

  it('VIP al final de su ventana (180 días) → urgencyScore=0, score=60, sigue en lista', () => {
    // Décision 1: urgencyScore=0 ≠ exclusión. Es "última oportunidad".
    // Score total = 60, que supera a BAJO inicio de ventana (10+40=50).
    const r = computeScore({ daysInactive: 180, segment: 'vip', totalDepositAmount: null })
    expect(r.urgencyScore).toBe(0)
    expect(r.valueScore).toBe(60)
    expect(r.total).toBe(60)
    expect(r.reactivationSegment).toBe('REACTIVACION_FRIA_ALTO_VALOR')
  })

  it('VIP 181 días → fuera de ventana, segment null', () => {
    const r = computeScore({ daysInactive: 181, segment: 'vip', totalDepositAmount: null })
    expect(r.reactivationSegment).toBeNull()
  })

  it('ALTO inactivo 130 días → FRIA_ALTO_VALOR', () => {
    const r = computeScore({ daysInactive: 130, segment: 'alto', totalDepositAmount: null })
    expect(r.reactivationSegment).toBe('REACTIVACION_FRIA_ALTO_VALOR')
    expect(r.valueTier).toBe('alto')
  })

  it('ALTO inactivo 20 días → URGENTE con score > 75', () => {
    const r = computeScore({ daysInactive: 20, segment: 'alto', totalDepositAmount: null })
    expect(r.reactivationSegment).toBe('REACTIVACION_URGENTE')
    expect(r.total).toBeGreaterThan(75)
  })

  it('propiedad clave: VIP fin de ventana (score=60) > BAJO inicio de ventana (score=50)', () => {
    const vipFin = computeScore({ daysInactive: 180, segment: 'vip', totalDepositAmount: null })
    const bajoComienzo = computeScore({ daysInactive: 30, segment: 'bajo', totalDepositAmount: null })
    expect(vipFin.total).toBeGreaterThan(bajoComienzo.total) // 60 > 50
  })

  it('score decae monotónicamente para el mismo tier', () => {
    const a = computeScore({ daysInactive: 7,   segment: 'vip', totalDepositAmount: null })
    const b = computeScore({ daysInactive: 60,  segment: 'vip', totalDepositAmount: null })
    const c = computeScore({ daysInactive: 120, segment: 'vip', totalDepositAmount: null })
    const d = computeScore({ daysInactive: 160, segment: 'vip', totalDepositAmount: null })
    expect(a.total).toBeGreaterThan(b.total)
    expect(b.total).toBeGreaterThan(c.total)
    expect(c.total).toBeGreaterThan(d.total)
  })

  it('monto disponible overridea segment para el tier', () => {
    const r = computeScore({ daysInactive: 10, segment: 'bajo', totalDepositAmount: 10_000 })
    expect(r.valueTier).toBe('vip')
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
    for (const tier of ['vip', 'alto', 'medio', 'bajo'] as const) {
      expect(INACTIVITY_WINDOWS[tier].minDays).toBeGreaterThan(0)
      expect(INACTIVITY_WINDOWS[tier].maxDays).toBeGreaterThan(INACTIVITY_WINDOWS[tier].minDays)
    }
  })

  it('VALUE_SCORES garantizan que VIP+0 > BAJO+40 (orden inter-tier preservado)', () => {
    expect(VALUE_SCORES.vip + 0).toBeGreaterThan(VALUE_SCORES.bajo + 40)
  })

  it('VALUE_SCORES están ordenados: vip > alto > medio > bajo', () => {
    expect(VALUE_SCORES.vip).toBeGreaterThan(VALUE_SCORES.alto)
    expect(VALUE_SCORES.alto).toBeGreaterThan(VALUE_SCORES.medio)
    expect(VALUE_SCORES.medio).toBeGreaterThan(VALUE_SCORES.bajo)
  })

  it('cooldowns de recontacto son más largos para tiers de menor valor', () => {
    expect(RECONTACT_COOLDOWN_DAYS.bajo).toBeGreaterThan(RECONTACT_COOLDOWN_DAYS.vip)
    expect(RECONTACT_COOLDOWN_DAYS.medio).toBeGreaterThan(RECONTACT_COOLDOWN_DAYS.alto)
  })

  it('VIP tiene la ventana más larga (mayor LTV justifica más intentos)', () => {
    expect(INACTIVITY_WINDOWS.vip.maxDays).toBeGreaterThan(INACTIVITY_WINDOWS.alto.maxDays)
    expect(INACTIVITY_WINDOWS.alto.maxDays).toBeGreaterThan(INACTIVITY_WINDOWS.medio.maxDays)
  })
})
