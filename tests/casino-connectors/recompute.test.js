'use strict'

const { BaseCasinoConnector } = require('../../src/casino-connectors/base/BaseCasinoConnector')
const { createFakeCasinoDb }  = require('./helpers/fakeCasinoDb')

/**
 * End-to-end idempotency / identity tests for the D1 (recompute, not
 * accumulate) and D2 (platform+username identity) fixes, run through the real
 * `syncAgent()` pipeline against a fake in-memory Postgres (see
 * helpers/fakeCasinoDb.js for what it does and does not prove).
 */

class TestConnector extends BaseCasinoConnector {
  constructor(config, pool, batches) {
    super(config, pool)
    this._batches = batches // array of raw batches returned in order, one per call
    this._call = 0
  }
  async fetchTransactions() { return this._batches[this._call++] ?? [] }
  async normalizeTransactions(raw) { return raw }
  async healthCheck() { return true }
}

function makeConnector(platform, pool, batches) {
  return new TestConnector({ name: platform, type: platform, baseUrl: 'https://x', endpoint: '/x' }, pool, batches)
}

function tx({ username, agente, tipo, monto, fecha, fecha_hora_utc = null, id_rec = null }) {
  return { id_rec, username, agente, tipo, monto, fecha, fecha_hora_utc, raw_detalles: tipo }
}

describe('casino sync idempotency & identity (D1/D2, fase 1 acceptance criteria)', () => {

  it('syncing the exact same range twice leaves casino_players identical (no duplication)', async () => {
    const db = createFakeCasinoDb()
    const batch = [
      tx({ username: 'juan22', agente: 'betcoin', tipo: 'carga',  monto: 1000, fecha: '2025-01-01' }),
      tx({ username: 'juan22', agente: 'betcoin', tipo: 'retiro', monto: 200,  fecha: '2025-01-02' }),
    ]
    const connector = makeConnector('zeus', db.pool, [batch, batch])

    await connector.syncAgent('betcoin', '2025-01-01', '2025-01-02')
    const after1 = db.players.get('zeus:juan22')

    await connector.syncAgent('betcoin', '2025-01-01', '2025-01-02')
    const after2 = db.players.get('zeus:juan22')

    expect(after1).toEqual(after2)
    expect(after2.total_cargas).toBe(1000)
    expect(after2.total_retiros).toBe(200)
    expect(db.transactions.length).toBe(2) // second sync deduped, nothing new inserted
  })

  it('the same username on two different platforms produces two independent rows', async () => {
    const db = createFakeCasinoDb()
    const zeus  = makeConnector('zeus',  db.pool, [[tx({ username: 'bigwin', agente: 'ofizeus', tipo: 'carga', monto: 5000, fecha: '2025-01-01' })]])
    const bet30 = makeConnector('bet30', db.pool, [[tx({ username: 'bigwin', agente: 'zeus',    tipo: 'carga', monto: 999,  fecha: '2025-01-01' })]])

    await zeus.syncAgent('ofizeus', '2025-01-01', '2025-01-01')
    await bet30.syncAgent('zeus', '2025-01-01', '2025-01-01')

    const zeusRow  = db.players.get('zeus:bigwin')
    const bet30Row = db.players.get('bet30:bigwin')
    expect(zeusRow.total_cargas).toBe(5000)
    expect(bet30Row.total_cargas).toBe(999)
    expect(zeusRow).not.toEqual(bet30Row)
  })

  it('a player who changes agente within the same platform keeps ALL of their history, regardless of sync order', async () => {
    // Forward order: agentA syncs first, then agentB (both operate the same platform).
    const forwardDb = createFakeCasinoDb()
    const c1 = makeConnector('zeus', forwardDb.pool, [
      [tx({ username: 'ana', agente: 'betcoin', tipo: 'carga', monto: 1000, fecha: '2025-01-01', fecha_hora_utc: '2025-01-01T10:00:00.000Z' })],
    ])
    const c2 = makeConnector('zeus', forwardDb.pool, [
      [tx({ username: 'ana', agente: 'ofizeus', tipo: 'carga', monto: 500, fecha: '2025-02-01', fecha_hora_utc: '2025-02-01T10:00:00.000Z' })],
    ])
    await c1.syncAgent('betcoin', '2025-01-01', '2025-01-01')
    await c2.syncAgent('ofizeus', '2025-02-01', '2025-02-01')
    const forwardResult = forwardDb.players.get('zeus:ana')

    // Reverse order: agentB's data lands first, then agentA's — same final DB state.
    const reverseDb = createFakeCasinoDb()
    const c3 = makeConnector('zeus', reverseDb.pool, [
      [tx({ username: 'ana', agente: 'ofizeus', tipo: 'carga', monto: 500, fecha: '2025-02-01', fecha_hora_utc: '2025-02-01T10:00:00.000Z' })],
    ])
    const c4 = makeConnector('zeus', reverseDb.pool, [
      [tx({ username: 'ana', agente: 'betcoin', tipo: 'carga', monto: 1000, fecha: '2025-01-01', fecha_hora_utc: '2025-01-01T10:00:00.000Z' })],
    ])
    await c3.syncAgent('ofizeus', '2025-02-01', '2025-02-01')
    await c4.syncAgent('betcoin', '2025-01-01', '2025-01-01')
    const reverseResult = reverseDb.players.get('zeus:ana')

    // Regardless of order, the player's total includes BOTH agentes' transactions,
    // and `agente` reflects whichever transaction is most recent (ofizeus, 2025-02-01).
    expect(forwardResult.total_cargas).toBe(1500)
    expect(forwardResult.agente).toBe('ofizeus')
    expect(reverseResult).toEqual(forwardResult)
  })

  it('preserves cents across the recompute — never rounds/truncates to whole pesos', async () => {
    // D3: casino_players.total_cargas/total_retiros are NUMERIC(20,2) (migration 127),
    // not BIGINT. A recompute that rounds to whole pesos here would silently drop cents
    // for any platform whose amounts aren't pre-rounded (Argenbet/Ganamos, fases 2/3) —
    // and Zeus/Bet30 aren't guaranteed to always be integers either.
    const db = createFakeCasinoDb()
    const connector = makeConnector('zeus', db.pool, [[
      tx({ username: 'leo', agente: 'betcoin', tipo: 'carga', monto: 100.50, fecha: '2025-01-01' }),
      tx({ username: 'leo', agente: 'betcoin', tipo: 'carga', monto: 33.33,  fecha: '2025-01-02' }),
      tx({ username: 'leo', agente: 'betcoin', tipo: 'retiro', monto: 10.01, fecha: '2025-01-03' }),
    ]])
    await connector.syncAgent('betcoin', '2025-01-01', '2025-01-03')
    const row = db.players.get('zeus:leo')
    expect(row.total_cargas).toBeCloseTo(133.83, 2)
    expect(row.total_retiros).toBeCloseTo(10.01, 2)
  })

  it('exact cents case requested in review: 123.45 + 0.22 = 123.67 (carga), 14.67 (retiro) untouched', async () => {
    const db = createFakeCasinoDb()
    const connector = makeConnector('zeus', db.pool, [[
      tx({ username: 'nora', agente: 'betcoin', tipo: 'carga',  monto: 123.45, fecha: '2025-01-01' }),
      tx({ username: 'nora', agente: 'betcoin', tipo: 'carga',  monto: 0.22,   fecha: '2025-01-02' }),
      tx({ username: 'nora', agente: 'betcoin', tipo: 'retiro', monto: 14.67,  fecha: '2025-01-03' }),
    ]])
    await connector.syncAgent('betcoin', '2025-01-01', '2025-01-03')
    const row = db.players.get('zeus:nora')
    expect(row.total_cargas).toBe(123.67)
    expect(row.total_retiros).toBe(14.67)
  })

  it('a withdrawal after the last deposit does not move fecha_ultima (no reactivation by retiro)', async () => {
    const db = createFakeCasinoDb()
    const connector = makeConnector('zeus', db.pool, [[
      tx({ username: 'carla', agente: 'betcoin', tipo: 'carga',  monto: 1000, fecha: '2025-01-01' }),
      tx({ username: 'carla', agente: 'betcoin', tipo: 'retiro', monto: 500,  fecha: '2025-06-01' }),
    ]])
    await connector.syncAgent('betcoin', '2025-01-01', '2025-06-01')
    const row = db.players.get('zeus:carla')
    expect(row.fecha_primera).toBe('2025-01-01')
    expect(row.fecha_ultima).toBe('2025-01-01') // NOT 2025-06-01 — that's a retiro, not a carga
  })
})
