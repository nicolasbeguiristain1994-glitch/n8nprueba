import { describe, expect, it } from 'vitest'
import { describeDateRange, exclusiveEndDate, queryDateRange, validCustomRange } from '../dashboard-date-range'
import { normalizeDateRange } from '@/components/dashboard/types'

describe('dashboard date range semantics', () => {
  it('maps a custom Aug 1 → Sep 1 range to the inclusive days Aug 1–31', () => {
    const range = { preset: 'custom', from: '2026-08-01', to: '2026-09-01' }
    expect(queryDateRange(range)).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    expect(exclusiveEndDate(range)).toBe('2026-09-01')
    expect(describeDateRange(range)).toBe('01/08/2026 00:00 → 01/09/2026 00:00 (sin incluir 01/09/2026) · incluye 01/08/2026 al 31/08/2026')
  })
  it('handles month, year and leap-day boundaries', () => {
    expect(queryDateRange({ preset: 'custom', from: '2028-02-01', to: '2028-03-01' }).to).toBe('2028-02-29')
    expect(queryDateRange({ preset: 'custom', from: '2026-12-01', to: '2027-01-01' }).to).toBe('2026-12-31')
    expect(describeDateRange({ preset: 'custom', from: '2026-08-15', to: '2026-08-16' })).toContain('incluye 15/08/2026')
  })
  it('leaves presets inclusive of full days', () => {
    const range = { preset: '7d', from: '2026-09-18', to: '2026-09-24' }
    expect(queryDateRange(range)).toEqual({ from: '2026-09-18', to: '2026-09-24' })
    expect(exclusiveEndDate(range)).toBe('2026-09-25')
    expect(describeDateRange(range)).toBe('18/09/2026 al 24/09/2026, días completos')
  })
  it('requires Desde strictly before Hasta for custom ranges', () => {
    expect(validCustomRange('2026-08-01', '2026-09-01')).toBe(true)
    expect(validCustomRange('2026-08-01', '2026-08-01')).toBe(false)
    expect(validCustomRange('2026-09-01', '2026-08-01')).toBe(false)
    expect(validCustomRange('2026-02-30', '2026-03-01')).toBe(false)
    expect(validCustomRange('', '2026-03-01')).toBe(false)
  })
})

describe('normalizeDateRange for persisted custom ranges', () => {
  it('keeps a valid exclusive range as saved', () => {
    expect(normalizeDateRange({ preset: 'custom', from: '2026-08-01', to: '2026-09-01' })).toEqual({ preset: 'custom', from: '2026-08-01', to: '2026-09-01' })
  })
  it('reads a saved from == to as that single full day', () => {
    expect(normalizeDateRange({ preset: 'custom', from: '2026-08-31', to: '2026-08-31' })).toEqual({ preset: 'custom', from: '2026-08-31', to: '2026-09-01' })
  })
  it('resets reversed or malformed custom ranges to the 7-day preset', () => {
    expect(normalizeDateRange({ preset: 'custom', from: '2026-09-02', to: '2026-09-01' }).preset).toBe('7d')
    expect(normalizeDateRange({ preset: 'custom', from: 'x', to: '2026-09-01' }).preset).toBe('7d')
  })
})
