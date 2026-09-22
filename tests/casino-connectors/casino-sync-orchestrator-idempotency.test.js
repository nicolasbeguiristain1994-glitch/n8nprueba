'use strict'

/**
 * End-to-end idempotency test for runOrchestrator(), through a REAL
 * BaseCasinoConnector subclass (not a mock that just returns a
 * pre-programmed `insertedTxCount`) against the fake in-memory Postgres
 * already used by recompute.test.js. This exercises the full path:
 * advisory lock -> casino_sync_runs bookkeeping -> connector.syncAgent()
 * (fetch -> normalize -> insertTransactions -> recomputePlayers) -> lock
 * release, ten times over the exact same batch, and asserts on the REAL
 * dedup/aggregation behavior (financial totals, player count, tx count),
 * not on a mock's return value.
 */

const { runOrchestrator }    = require('../../scripts/lib/casino-sync-orchestrator')
const { BaseCasinoConnector } = require('../../src/casino-connectors/base/BaseCasinoConnector')
const { createFakeCasinoDb }  = require('./helpers/fakeCasinoDb')

class FixedBatchConnector extends BaseCasinoConnector {
  constructor(config, pool, batch) {
    super(config, pool)
    this._batch = batch
  }
  async fetchTransactions() { return this._batch }
  async normalizeTransactions(raw) { return raw }
  async healthCheck() { return true }
}

function tx({ username, agente, tipo, monto, fecha, fecha_hora_utc }) {
  return { id_rec: null, username, agente, tipo, monto, fecha, fecha_hora_utc, raw_detalles: tipo }
}

/**
 * Wraps a fakeCasinoDb pool with casino_sync_runs bookkeeping + advisory
 * lock support (the two things runOrchestrator needs beyond what
 * BaseCasinoConnector itself touches), delegating anything else to the
 * fake DB's own query dispatch.
 */
function makeCombinedPool(fakeDb) {
  const runs = []
  let nextId = 1
  let locked = false

  async function query(sql, params = []) {
    if (sql.startsWith('INSERT INTO casino_sync_runs')) {
      const [platform, agente, startedAt, desde, hasta] = params
      const row = { id: nextId++, platform, agente, started_at: startedAt, range_desde: desde, range_hasta: hasta, status: 'running' }
      runs.push(row)
      return { rows: [{ id: row.id }] }
    }
    if (sql.startsWith('UPDATE casino_sync_runs') && sql.includes("status = 'running'")) {
      return { rowCount: 0 } // no abandoned rows in this test
    }
    if (sql.startsWith('UPDATE casino_sync_runs')) {
      const [id, status, finishedAt, txInserted, error] = params
      Object.assign(runs.find((r) => r.id === id), { status, finished_at: finishedAt, tx_inserted: txInserted, error })
      return { rowCount: 1 }
    }
    return fakeDb.pool.query(sql, params)
  }

  const client = {
    query: async (sql, params = []) => {
      if (sql.includes('pg_try_advisory_lock')) {
        if (locked) return { rows: [{ locked: false }] }
        locked = true
        return { rows: [{ locked: true }] }
      }
      if (sql.includes('pg_advisory_unlock')) {
        locked = false
        return { rows: [{}] }
      }
      const realClient = await fakeDb.pool.connect()
      return realClient.query(sql, params)
    },
    release: () => {},
  }

  return { pool: { query, connect: async () => client }, runs }
}

describe('runOrchestrator idempotency (real BaseCasinoConnector + fake Postgres, D4 acceptance criteria)', () => {
  it('running the exact same sync 10 times in a row leaves casino_players totals and casino_transactions count identical from the second run onward', async () => {
    const fakeDb = createFakeCasinoDb()
    const { pool } = makeCombinedPool(fakeDb)

    const batch = [
      tx({ username: 'juan22', agente: 'betcoin', tipo: 'carga',  monto: 1000, fecha: '2025-01-01', fecha_hora_utc: '2025-01-01T10:00:00.000Z' }),
      tx({ username: 'juan22', agente: 'betcoin', tipo: 'retiro', monto: 200,  fecha: '2025-01-02', fecha_hora_utc: '2025-01-02T10:00:00.000Z' }),
    ]
    const connector = new FixedBatchConnector({ name: 'zeus', type: 'zeus', baseUrl: 'https://x', endpoint: '/x' }, pool, batch)

    const txInsertedPerRun = []
    for (let i = 0; i < 10; i++) {
      const result = await runOrchestrator({
        platform: 'zeus', pool, createConnector: () => connector, clock: () => new Date('2026-01-01T00:00:00Z'),
        agentes: ['betcoin'], auto: false, desde: '2025-01-01', hasta: '2025-01-02',
        log: { info: () => {}, warn: () => {}, error: () => {} },
      })
      txInsertedPerRun.push(result.results[0].txInserted)
    }

    expect(txInsertedPerRun[0]).toBe(2)
    expect(txInsertedPerRun.slice(1)).toEqual(new Array(9).fill(0)) // every replay dedups to zero new inserts

    expect(fakeDb.transactions).toHaveLength(2) // never duplicated, no matter how many replays
    const player = fakeDb.players.get('zeus:juan22')
    expect(player.total_cargas).toBe(1000)
    expect(player.total_retiros).toBe(200)
    expect(player.cant_cargas).toBe(1)
    expect(player.cant_retiros).toBe(1)
  })
})
