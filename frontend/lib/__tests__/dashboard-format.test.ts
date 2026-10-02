import { describe, it, expect } from 'vitest'
import { argentinaToday, shiftDate, validDateRange, formatPesos, formatProviderPesos } from '../dashboard-format'

describe('dashboard dates and money', () => {
  it('uses the Argentina calendar around UTC midnight', () => {
    expect(argentinaToday(new Date('2026-09-23T01:00:00Z'))).toBe('2026-09-22')
    expect(shiftDate('2026-09-23', -6)).toBe('2026-09-17')
    expect(shiftDate('2024-03-01', -1)).toBe('2024-02-29')
  })
  it('rejects impossible or reversed dates', () => {
    expect(validDateRange('2026-02-30', '2026-03-01')).toBe(false)
    expect(validDateRange('2026-09-23', '2026-09-22')).toBe(false)
    expect(validDateRange('2026-09-23', '2026-09-23')).toBe(true)
    expect(validDateRange('', '2026-09-23')).toBe(false)
  })
  it('preserves cents beyond the safe integer range', () => {
    expect(formatPesos('9007199254740993.27')).toBe('$ 9.007.199.254.740.993,27')
    expect(formatPesos('-1024.05')).toBe('-$ 1.024,05')
    expect(formatPesos('9.999')).toBe('$ 10,00')
    expect(formatPesos('0')).toBe('$ 0,00')
    expect(formatPesos('oops')).toBe('—')
  })
})

it('matches Argenbet truncation after summing original amounts, not per operation', () => {
 expect(formatProviderPesos('14920991.66717','argenbet')).toBe('$ 14.920.991,66')
 expect(formatProviderPesos('7977562.33283','argenbet')).toBe('$ 7.977.562,33')
 expect(formatProviderPesos('9.999','zeus')).toBe('$ 10,00')
})
