import { describe, expect, it } from 'vitest'
import { previousMonthRange, queryDateRange } from '../dashboard-date-range'

describe('previous calendar month for sales', () => {
  it.each([
    ['2026-09-01','2026-09-30','2026-08-01','2026-08-31'],
    ['2026-10-01','2026-10-20','2026-09-01','2026-09-20'],
    ['2026-01-01','2026-01-31','2025-12-01','2025-12-31'],
    ['2028-03-01','2028-03-31','2028-02-01','2028-02-29'],
    ['2026-03-01','2026-03-31','2026-02-01','2026-02-28'],
    ['2026-03-30','2026-03-31','2026-02-28','2026-02-28'],
    ['2026-09-21','2026-10-20','2026-08-21','2026-09-20'],
    ['2026-09-10','2026-09-30','2026-08-10','2026-08-30'],
  ])('compares %s–%s with %s–%s', (from,to,prevFrom,prevTo) => {
    expect(previousMonthRange(from,to)).toEqual({from:prevFrom,to:prevTo})
  })
  it('converts the screenshot exclusive end before comparing full months', () => {
    const range=queryDateRange({preset:'custom',from:'2026-09-01',to:'2026-10-01'})
    expect(previousMonthRange(range.from,range.to)).toEqual({from:'2026-08-01',to:'2026-08-31'})
  })
})
