'use strict'

const { resolveIncrementalRange } = require('../../src/casino-connectors/shared/incrementalWindow')

function poolWith({ last = null, runs }) {
  return { query: jest.fn(async (sql) => {
    if (sql.includes('FROM casino_sync_runs')) return { rows: runs }
    if (sql.includes('MAX(fecha_hora_utc)')) return { rows: [{ last }] }
    if (sql.includes('MAX(fecha)')) return { rows: [{ last_fecha: null }] }
    throw new Error(`Unexpected query: ${sql}`)
  }) }
}

describe('recovery ranges across Argentina midnight', () => {
  it('a failed calendar day must never move the existing UTC overlap forwards', async () => {
    const pool = poolWith({ last: '2026-09-21T01:30:00Z', runs: [{
      status: 'failed', range_desde: '2026-09-21', range_hasta: '2026-09-21',
      started_at: '2026-09-21T08:00:00Z',
    }] })
    const range = await resolveIncrementalRange(pool, 'argenbet', 'adminbtc', { now: new Date('2026-09-21T12:00:00Z') })
    // The normal overlap starts at 01:00Z; the failed ART day starts LATER, 03:00Z.
    expect(range.desde).toBe('2026-09-21T01:00:00.000Z')
  })

  it('Ganamos recovers the Argentina day containing an unresolved UTC timestamp', async () => {
    const pool = poolWith({ runs: [{
      status: 'failed', range_desde: '2026-09-22T01:00:00Z', range_hasta: '2026-09-22T02:00:00Z',
      started_at: '2026-09-22T02:00:00Z',
    }] })
    const range = await resolveIncrementalRange(pool, 'ganamos', 'adminbtc', { now: new Date('2026-09-22T12:00:00Z') })
    expect(range.desde).toBe('2026-09-21')
    expect(range.hasta).toBe('2026-09-22')
  })

  it('recovers yesterday after a platform configuration failure before any agent could start', async () => {
    const failure = {
      id: 1, agente: null, status: 'failed', range_desde: null, range_hasta: null,
      started_at: '2026-09-21T12:00:00Z', finished_at: '2026-09-21T12:00:01Z',
    }
    const pool = { query: jest.fn(async (sql) => {
      if (sql.includes('FROM casino_sync_runs')) {
        // A query limited to agente=$2 cannot see a platform-level failure.
        return { rows: /agente IS NULL/.test(sql) && !/range_desde IS NOT NULL/.test(sql) ? [failure] : [] }
      }
      if (sql.includes('MAX(fecha)')) return { rows: [{ last_fecha: null }] }
      throw new Error(`Unexpected query: ${sql}`)
    }) }
    const range = await resolveIncrementalRange(pool, 'ganamos', 'adminbtc', { now: new Date('2026-09-22T12:00:00Z') })
    expect(range.desde).toBe('2026-09-21')
  })

  it('keeps the earliest missed day after several consecutive platform failures', async () => {
    const failures = ['2026-09-19', '2026-09-20', '2026-09-21'].map((day) => ({
      status: 'failed', agente: null, range_desde: null, range_hasta: null,
      started_at: `${day}T12:00:00Z`,
    }))
    const pool = { query: jest.fn(async (sql) => {
      if (sql.includes('FROM casino_sync_runs')) {
        if (!/agente IS NULL/.test(sql)) return { rows: [] }
        return { rows: /DESC\s+LIMIT 1/i.test(sql) ? failures.slice(-1) : failures }
      }
      if (sql.includes('MAX(fecha)')) return { rows: [{ last_fecha: null }] }
      throw new Error(`Unexpected query: ${sql}`)
    }) }
    const range = await resolveIncrementalRange(pool, 'ganamos', 'adminbtc', { now: new Date('2026-09-22T12:00:00Z') })
    expect(range.desde).toBe('2026-09-19')
  })
})
