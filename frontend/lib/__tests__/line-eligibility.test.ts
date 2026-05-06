/**
 * line-eligibility.test.ts
 * @vitest-environment node
 *
 * Verifica que lineEligibleExpr() produce la expresión SQL correcta,
 * con y sin alias de tabla.
 */

import { describe, it, expect } from 'vitest'
import { lineEligibleExpr } from '@/lib/line-eligibility'

const CRITERIA = [
  "status = 'active'",
  'is_connected = true',
  'sending_enabled = true',
  'msgs_sent_hour < msg_per_hour',
  'msgs_sent_today < msg_per_day',
  "allowed_types IS NULL OR",
  "'[\"campaign\"]'::jsonb",
]

describe('lineEligibleExpr — sin alias', () => {
  const expr = lineEligibleExpr()

  it('contiene todos los criterios de elegibilidad', () => {
    for (const criterion of CRITERIA) {
      expect(expr).toContain(criterion)
    }
  })

  it('no contiene prefijos de tabla', () => {
    // Con alias vacío, no debe aparecer ningún "x." donde x sea alias de tabla
    expect(expr).not.toMatch(/[a-z]+\.status/)
    expect(expr).not.toMatch(/[a-z]+\.is_connected/)
    expect(expr).not.toMatch(/[a-z]+\.sending_enabled/)
  })
})

describe('lineEligibleExpr — con alias "l"', () => {
  const expr = lineEligibleExpr('l')

  it('prefija todas las columnas con el alias', () => {
    expect(expr).toContain("l.status = 'active'")
    expect(expr).toContain('l.is_connected = true')
    expect(expr).toContain('l.sending_enabled = true')
    expect(expr).toContain('l.msgs_sent_hour < l.msg_per_hour')
    expect(expr).toContain('l.msgs_sent_today < l.msg_per_day')
    expect(expr).toContain('l.allowed_types IS NULL')
    expect(expr).toContain('l.allowed_types @>')
  })

  it('no contiene columnas sin prefijo', () => {
    // Verifica que no haya referencias sin alias (e.g. " status" o "(status")
    // Lookbehind incluye '.' para que 'l.status' no sea falsamente rechazado
    expect(expr).not.toMatch(/(?<![a-z\d_.])status\s*=/)
    expect(expr).not.toMatch(/(?<![a-z\d_.])is_connected\s*=/)
    expect(expr).not.toMatch(/(?<![a-z\d_.])sending_enabled\s*=/)
  })
})

describe('lineEligibleExpr — alias personalizado "wl"', () => {
  const expr = lineEligibleExpr('wl')

  it('usa el alias proporcionado en todos los campos', () => {
    expect(expr).toContain("wl.status = 'active'")
    expect(expr).toContain('wl.is_connected = true')
    expect(expr).toContain('wl.msgs_sent_hour < wl.msg_per_hour')
  })
})
