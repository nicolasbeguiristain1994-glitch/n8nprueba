'use strict'

const {
  isValidDate, argToday, addDays, lastClosedDay, buildDateChunks, daysInclusive,
} = require('../../src/casino-connectors/sync/dates')
const { advanceCursor, resolveAutoRange } = require('../../src/casino-connectors/sync/cursor')

// 2026-09-13 12:00 ART = 15:00 UTC
const NOON_ART = new Date('2026-09-13T15:00:00.000Z')

describe('dates (hora Argentina)', () => {
  it('validates real calendar dates only', () => {
    expect(isValidDate('2026-02-28')).toBe(true)
    expect(isValidDate('2026-02-30')).toBe(false)
    expect(isValidDate('2026-9-1')).toBe(false)
    expect(isValidDate('true')).toBe(false)
    expect(isValidDate(undefined)).toBe(false)
  })

  it('argToday uses UTC-3: 01:30 UTC is still the previous day in Argentina', () => {
    expect(argToday(new Date('2026-09-14T01:30:00.000Z'))).toBe('2026-09-13')
    expect(argToday(new Date('2026-09-14T03:00:00.000Z'))).toBe('2026-09-14')
  })

  it('lastClosedDay is yesterday in Argentina at fetch start', () => {
    expect(lastClosedDay(NOON_ART)).toBe('2026-09-12')
    // 23:59 ART del 13 → el 13 todavía no cerró
    expect(lastClosedDay(new Date('2026-09-14T02:59:00.000Z'))).toBe('2026-09-12')
    // 00:00 ART del 14 → el 13 ya cerró
    expect(lastClosedDay(new Date('2026-09-14T03:00:00.000Z'))).toBe('2026-09-13')
  })

  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('buildDateChunks covers the range without gaps or overlaps', () => {
    const chunks = buildDateChunks('2026-01-01', '2026-03-05', 30)
    expect(chunks[0]).toEqual({ desde: '2026-01-01', hasta: '2026-01-30' })
    expect(chunks[chunks.length - 1].hasta).toBe('2026-03-05')
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].desde).toBe(addDays(chunks[i - 1].hasta, 1))
    }
    const total = chunks.reduce((s, c) => s + daysInclusive(c.desde, c.hasta), 0)
    expect(total).toBe(daysInclusive('2026-01-01', '2026-03-05'))
  })

  it('buildDateChunks returns a single chunk when the range fits', () => {
    expect(buildDateChunks('2026-09-12', '2026-09-13', 30)).toEqual([{ desde: '2026-09-12', hasta: '2026-09-13' }])
  })
})

describe('advanceCursor()', () => {
  const range = (desde, hasta, at = NOON_ART) => ({ desde, hasta, fetchStartedAt: at })

  it('establishes the cursor from the first success, only over closed days', () => {
    const r = advanceCursor(null, range('2026-09-01', '2026-09-13'))
    expect(r).toEqual({ cursor: { coveredFrom: '2026-09-01', coveredThrough: '2026-09-12' }, moved: true, reason: 'established' })
  })

  it('does not move when the range only contains the day in course', () => {
    const cur = { coveredFrom: '2026-09-01', coveredThrough: '2026-09-12' }
    const r   = advanceCursor(cur, range('2026-09-13', '2026-09-13'))
    expect(r.moved).toBe(false)
    expect(r.cursor).toBe(cur)
    expect(advanceCursor(null, range('2026-09-13', '2026-09-13')).cursor).toBeNull()
  })

  it('extends on a contiguous range and on an overlapping range', () => {
    const cur = { coveredFrom: '2026-09-01', coveredThrough: '2026-09-10' }
    expect(advanceCursor(cur, range('2026-09-11', '2026-09-12')).cursor.coveredThrough).toBe('2026-09-12')
    expect(advanceCursor(cur, range('2026-09-10', '2026-09-13')).cursor.coveredThrough).toBe('2026-09-12')
  })

  it('does not jump over a gap (disjoint manual range after the cursor)', () => {
    const cur = { coveredFrom: '2026-09-01', coveredThrough: '2026-09-05' }
    const r   = advanceCursor(cur, range('2026-09-08', '2026-09-10'))
    expect(r).toMatchObject({ moved: false, reason: 'disjoint' })
    expect(r.cursor).toEqual(cur)
  })

  it('does not move for a disjoint range before the cursor', () => {
    const cur = { coveredFrom: '2026-09-10', coveredThrough: '2026-09-12' }
    expect(advanceCursor(cur, range('2026-09-01', '2026-09-05')).moved).toBe(false)
  })

  it('extends backwards when an earlier range touches coveredFrom', () => {
    const cur = { coveredFrom: '2026-09-10', coveredThrough: '2026-09-12' }
    const r   = advanceCursor(cur, range('2026-09-01', '2026-09-09'))
    expect(r.cursor).toEqual({ coveredFrom: '2026-09-01', coveredThrough: '2026-09-12' })
  })

  it('reports already_covered for a range inside the cursor', () => {
    const cur = { coveredFrom: '2026-09-01', coveredThrough: '2026-09-12' }
    expect(advanceCursor(cur, range('2026-09-05', '2026-09-06'))).toMatchObject({ moved: false, reason: 'already_covered' })
  })
})

describe('resolveAutoRange()', () => {
  const today = '2026-09-13'

  it('fails closed without a cursor and without bootstrap', () => {
    expect(resolveAutoRange(null, { today })).toEqual({ error: 'CURSOR_MISSING' })
  })

  it('uses the explicit bootstrap for agents without a cursor', () => {
    expect(resolveAutoRange(null, { today, bootstrapDesde: '2026-08-01' })).toEqual({ desde: '2026-08-01', hasta: today })
  })

  it('re-visits the last closed day (overlap 1) through today', () => {
    const cur = { coveredFrom: '2026-09-01', coveredThrough: '2026-09-12' }
    expect(resolveAutoRange(cur, { today, overlapDays: 1 })).toEqual({ desde: '2026-09-12', hasta: today })
  })

  it('with overlap 0 starts at the first uncovered day', () => {
    const cur = { coveredFrom: '2026-09-01', coveredThrough: '2026-09-12' }
    expect(resolveAutoRange(cur, { today, overlapDays: 0 })).toEqual({ desde: '2026-09-13', hasta: today })
  })

  it('catches up a lagging cursor from its last covered day', () => {
    const cur = { coveredFrom: '2026-08-01', coveredThrough: '2026-08-20' }
    expect(resolveAutoRange(cur, { today })).toEqual({ desde: '2026-08-20', hasta: today })
  })

  it('never starts before coveredFrom even with a large overlap', () => {
    const cur = { coveredFrom: '2026-09-12', coveredThrough: '2026-09-12' }
    expect(resolveAutoRange(cur, { today, overlapDays: 7 }).desde).toBe('2026-09-12')
  })
})
