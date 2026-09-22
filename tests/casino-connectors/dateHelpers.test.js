'use strict'

const { buildApiDateRange } = require('../../src/casino-connectors/shared/dateHelpers')

describe('buildApiDateRange', () => {
  it('plain YYYY-MM-DD dates behave exactly like before (endDate bumped one day, ART midnight)', () => {
    const { startDate, endDate } = buildApiDateRange('2026-01-01', '2026-01-31', 3)
    expect(startDate).toBe('2026-01-01 00:00:00')
    expect(endDate).toBe('2026-02-01 00:00:00')
  })

  it('an exact ISO timestamp is formatted precisely — no toISOString()+" 00:00:00" concatenation', () => {
    // 2026-09-01T09:30:00.000Z in ART (UTC-3) is 2026-09-01 06:30:00 local.
    const { startDate } = buildApiDateRange('2026-09-01T09:30:00.000Z', '2026-09-01T12:00:00.000Z', 3)
    expect(startDate).toBe('2026-09-01 06:30:00')
  })

  it('endDate given as an exact timestamp is used as-is, never day-bumped', () => {
    const { endDate } = buildApiDateRange('2026-09-01T09:30:00.000Z', '2026-09-01T12:00:00.000Z', 3)
    expect(endDate).toBe('2026-09-01 09:00:00') // 12:00 UTC - 3h = 09:00 local
  })

  it('mixed inputs (plain desde, exact hasta) are supported independently', () => {
    const { startDate, endDate } = buildApiDateRange('2026-09-01', '2026-09-01T23:00:00.000Z', 3)
    expect(startDate).toBe('2026-09-01 00:00:00')
    expect(endDate).toBe('2026-09-01 20:00:00')
  })

  it('a UTC-midnight crossing shifts the local calendar day correctly', () => {
    // 2026-09-02T01:00:00Z minus 3h offset = 2026-09-01T22:00:00 local.
    const { startDate } = buildApiDateRange('2026-09-02T01:00:00.000Z', '2026-09-02T02:00:00.000Z', 3)
    expect(startDate).toBe('2026-09-01 22:00:00')
  })
})
