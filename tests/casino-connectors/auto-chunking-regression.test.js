'use strict'

const { runOrchestrator } = require('../../scripts/lib/casino-sync-orchestrator')

// The connector is mocked here to inspect the ranges handed to HTTP ingestion;
// real insert/recompute idempotency is covered in the separate integration fixture.
function emptyPool() {
  let id = 0
  const runs = []
  const query = jest.fn(async (sql, params = []) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] }
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] }
    if (sql.includes('MAX(fecha_hora_utc)')) return { rows: [{ last: null }] }
    if (/SELECT[\s\S]+FROM casino_sync_runs/.test(sql)) return { rows: [] }
    if (sql.startsWith('INSERT INTO casino_sync_runs')) {
      const [platform, agente, started_at, range_desde, range_hasta] = params
      const row = { id: ++id, platform, agente, started_at, range_desde, range_hasta, status: 'running' }
      runs.push(row)
      return { rows: [{ id: row.id }] }
    }
    if (sql.startsWith('UPDATE casino_sync_runs')) {
      if (['ok', 'failed'].includes(params[1])) {
        const row = runs.find((r) => r.id === params[0])
        if (row) row.status = params[1]
      }
      return { rowCount: 0, rows: [] }
    }
    throw new Error(`Unexpected query: ${sql}`)
  })
  return { runs, query, connect: async () => ({ query, release: jest.fn() }) }
}

it('splits an automatic bootstrap into bounded windows without losing the final instant', async () => {
  const syncAgent = jest.fn(async () => ({ insertedTxCount: 0, playerCount: 0 }))
  const now = new Date('2026-01-05T12:00:00Z')
  const pool = emptyPool()
  const result = await runOrchestrator({
    platform: 'argenbet', pool, auto: true, chunkDays: 2,
    agentes: ['adminbtc'], clock: () => now,
    createConnector: () => ({ authenticate: async () => {}, syncAgent }),
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  })
  expect(result.ok).toBe(true)
  expect(syncAgent.mock.calls.length).toBeGreaterThan(1)
  const instant = (s, end) => /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? Date.parse(`${s}T00:00:00-03:00`) + (end ? 86400000 : 0) : Date.parse(s)
  let nextStart = Date.parse('2026-01-01T00:00:00-03:00')
  for (const [, from, to] of syncAgent.mock.calls) {
    expect(instant(from, false)).toBe(nextStart)
    expect(instant(to, true) - instant(from, false)).toBeLessThanOrEqual(2 * 86400000)
    nextStart = instant(to, true)
  }
  expect(nextStart).toBe(now.getTime())
  // Recovery resolution requires a complete success covering the failed range.
  // Smaller successful chunks alone would leave an earlier wider failure pending forever.
  expect(pool.runs.some((r) => r.agente === 'adminbtc' && r.status === 'ok'
    && instant(r.range_desde, false) === Date.parse('2026-01-01T00:00:00-03:00')
    && instant(r.range_hasta, true) === now.getTime())).toBe(true)
})
