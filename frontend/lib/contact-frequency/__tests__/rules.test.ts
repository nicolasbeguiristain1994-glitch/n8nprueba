/**
 * rules.test.ts
 *
 * Tests unitarios de resolveApplicableRule().
 * Módulo puro: sin DB, sin mocks.
 *
 * Cobertura:
 *  ─ Sin reglas disponibles → DEFAULT_GLOBAL_RULE
 *  ─ Match exacto (3 campos) gana sobre parciales
 *  ─ Match parcial: operator solo, segmento solo, combinaciones
 *  ─ Comodín (null): acepta cualquier valor del contexto
 *  ─ Tie-break por created_at (más reciente gana)
 *  ─ Reglas inactivas no deben llegar a esta función (filtradas en repo)
 *  ─ Contextos con valores null/undefined en segmentos
 */

import { describe, it, expect } from 'vitest'
import { resolveApplicableRule, DEFAULT_GLOBAL_RULE } from '../rules'
import type { ContactFrequencyRule, SegMonto, SegActividad } from '../types'

// ── Helpers ───────────────────────────────────────────────────────────────────

let idCounter = 1
function makeRule(overrides: Partial<ContactFrequencyRule> = {}): ContactFrequencyRule {
  return {
    id:                      String(idCounter++).padStart(8, '0') + '-0000-0000-0000-000000000000',
    operator_id:             null,
    seg_monto:               null,
    seg_actividad:           null,
    max_per_day:             1,
    max_per_week:            2,
    min_hours_between_sends: 48,
    is_active:               true,
    created_at:              new Date('2025-01-01'),
    updated_at:              new Date('2025-01-01'),
    ...overrides,
  }
}

const OP_A = 'aaaaaaaa-0000-0000-0000-000000000000'
const OP_B = 'bbbbbbbb-0000-0000-0000-000000000000'

// ── Sin reglas ────────────────────────────────────────────────────────────────

describe('resolveApplicableRule — sin reglas', () => {

  it('lista vacía → DEFAULT_GLOBAL_RULE', () => {
    const result = resolveApplicableRule([], OP_A, 'alto', 'frecuente')
    expect(result).toBe(DEFAULT_GLOBAL_RULE)
    expect(result.max_per_day).toBe(1)
    expect(result.max_per_week).toBe(2)
  })

  it('sin regla que aplique → DEFAULT_GLOBAL_RULE', () => {
    // Regla solo para OP_B, contexto es OP_A
    const rules = [makeRule({ operator_id: OP_B })]
    const result = resolveApplicableRule(rules, OP_A, null, null)
    expect(result).toBe(DEFAULT_GLOBAL_RULE)
  })

})

// ── Comodines (null en la regla) ──────────────────────────────────────────────

describe('resolveApplicableRule — comodines', () => {

  it('regla global (todos null) aplica a cualquier contexto', () => {
    const globalRule = makeRule({ max_per_day: 99 })
    const result = resolveApplicableRule([globalRule], OP_A, 'alto', 'frecuente')
    expect(result.max_per_day).toBe(99)
  })

  it('regla global aplica cuando operatorId es null', () => {
    const globalRule = makeRule({ max_per_day: 5 })
    const result = resolveApplicableRule([globalRule], null, null, null)
    expect(result.max_per_day).toBe(5)
  })

  it('regla con seg_monto=null aplica a cualquier seg_monto del contexto', () => {
    const rule = makeRule({ operator_id: OP_A, seg_monto: null, max_per_day: 3 })
    const result = resolveApplicableRule([rule], OP_A, 'vip', null)
    expect(result.max_per_day).toBe(3)
  })

  it('regla con seg_actividad=null NO aplica si operator_id no coincide', () => {
    const rule = makeRule({ operator_id: OP_B, seg_actividad: null })
    const result = resolveApplicableRule([rule], OP_A, null, 'frecuente')
    expect(result).toBe(DEFAULT_GLOBAL_RULE)
  })

})

// ── Especificidad ─────────────────────────────────────────────────────────────

describe('resolveApplicableRule — especificidad', () => {

  it('regla exacta (3 campos) gana sobre regla de 2 campos', () => {
    const partialRule = makeRule({
      operator_id:   OP_A,
      seg_monto:     'vip',
      max_per_day:   5,
    })
    const exactRule = makeRule({
      operator_id:   OP_A,
      seg_monto:     'vip',
      seg_actividad: 'frecuente',
      max_per_day:   10,
    })
    const result = resolveApplicableRule([partialRule, exactRule], OP_A, 'vip', 'frecuente')
    expect(result.max_per_day).toBe(10)
  })

  it('regla con operator_id gana sobre regla global (solo segmentos)', () => {
    const globalSegRule = makeRule({ seg_monto: 'vip', max_per_day: 3 })
    const operatorRule  = makeRule({ operator_id: OP_A, max_per_day: 7 })
    const result = resolveApplicableRule([globalSegRule, operatorRule], OP_A, 'vip', null)
    // operator_id=OP_A → especificidad 4; seg_monto='vip' → especificidad 2
    expect(result.max_per_day).toBe(7)
  })

  it('orden en el array no afecta el resultado (el más específico siempre gana)', () => {
    const specificRule = makeRule({
      operator_id:   OP_A,
      seg_monto:     'alto',
      seg_actividad: 'regular',
      max_per_day:   99,
    })
    const globalRule = makeRule({ max_per_day: 1 })

    // Primero global, luego específico
    const r1 = resolveApplicableRule([globalRule, specificRule], OP_A, 'alto', 'regular')
    // Primero específico, luego global
    const r2 = resolveApplicableRule([specificRule, globalRule], OP_A, 'alto', 'regular')

    expect(r1.max_per_day).toBe(99)
    expect(r2.max_per_day).toBe(99)
  })

  it('tie-break por created_at: regla más reciente gana en caso de empate de especificidad', () => {
    const older  = makeRule({
      operator_id: OP_A,
      max_per_day: 1,
      created_at:  new Date('2024-01-01'),
    })
    const newer  = makeRule({
      operator_id: OP_A,
      max_per_day: 5,
      created_at:  new Date('2025-06-01'),
    })
    const result = resolveApplicableRule([older, newer], OP_A, null, null)
    expect(result.max_per_day).toBe(5)
  })

})

// ── Match parcial ─────────────────────────────────────────────────────────────

describe('resolveApplicableRule — match parcial', () => {

  it('regla solo por seg_monto aplica cuando coincide', () => {
    const rule = makeRule({ seg_monto: 'vip', max_per_day: 3 })
    const result = resolveApplicableRule([rule], null, 'vip', 'ocasional')
    expect(result.max_per_day).toBe(3)
  })

  it('regla solo por seg_monto NO aplica cuando no coincide', () => {
    const rule = makeRule({ seg_monto: 'vip', max_per_day: 3 })
    const result = resolveApplicableRule([rule], null, 'bajo', null)
    expect(result).toBe(DEFAULT_GLOBAL_RULE)
  })

  it('regla solo por seg_actividad aplica cuando coincide', () => {
    const rule = makeRule({ seg_actividad: 'en_riesgo', max_per_day: 1, min_hours_between_sends: 96 })
    const result = resolveApplicableRule([rule], OP_A, null, 'en_riesgo')
    expect(result.min_hours_between_sends).toBe(96)
  })

  it('regla para un operador aplica a cualquier segmento si segmentos son null', () => {
    const rule = makeRule({ operator_id: OP_A, max_per_day: 2 })
    const result = resolveApplicableRule([rule], OP_A, 'vip', 'frecuente')
    expect(result.max_per_day).toBe(2)
  })

})

// ── Segmentos undefined en el contexto ────────────────────────────────────────

describe('resolveApplicableRule — contexto con undefined', () => {

  it('segMonto=undefined se trata igual que null', () => {
    const globalRule = makeRule({ max_per_day: 9 })
    const r1 = resolveApplicableRule([globalRule], null, undefined, null)
    const r2 = resolveApplicableRule([globalRule], null, null,      null)
    expect(r1.max_per_day).toBe(r2.max_per_day)
  })

  it('segActividad=undefined no causa error', () => {
    const rule = makeRule({ seg_actividad: 'frecuente', max_per_day: 4 })
    // undefined → no coincide con 'frecuente' → DEFAULT_GLOBAL_RULE
    const result = resolveApplicableRule([rule], null, null, undefined)
    expect(result).toBe(DEFAULT_GLOBAL_RULE)
  })

})

// ── DEFAULT_GLOBAL_RULE ───────────────────────────────────────────────────────

describe('DEFAULT_GLOBAL_RULE', () => {

  it('tiene los valores no-negociables del negocio', () => {
    expect(DEFAULT_GLOBAL_RULE.max_per_day).toBe(1)
    expect(DEFAULT_GLOBAL_RULE.max_per_week).toBe(2)
    expect(DEFAULT_GLOBAL_RULE.min_hours_between_sends).toBe(48)
  })

  it('está congelado (inmutable)', () => {
    expect(Object.isFrozen(DEFAULT_GLOBAL_RULE)).toBe(true)
  })

  it('no puede ser modificado', () => {
    expect(() => {
      // @ts-expect-error — test intencional de inmutabilidad
      DEFAULT_GLOBAL_RULE.max_per_day = 999
    }).toThrow()
  })

})
