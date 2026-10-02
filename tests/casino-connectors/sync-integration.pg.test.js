'use strict'

/**
 * Integración contra PostgreSQL LOCAL.
 *
 * Solo corre si se define TEST_DATABASE_URL explícitamente. Nunca usa
 * DATABASE_URL, y se niega a correr si TEST_DATABASE_URL no apunta a localhost
 * (o a un socket local) o si coincide con DATABASE_URL.
 *
 * Crea un schema temporal, aplica las migraciones 025, 028, 031, 123 y 125 y lo
 * borra al terminar.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/wa_test npx jest sync-integration
 */

const fs     = require('fs')
const path   = require('path')
const { Pool } = require('pg')

const { BaseCasinoConnector } = require('../../src/casino-connectors/base/BaseCasinoConnector')
const { SyncRunStore }        = require('../../src/casino-connectors/sync/SyncRunStore')
const { runSync, EXIT }       = require('../../src/casino-connectors/sync/runner')
const { argToday, addDays }   = require('../../src/casino-connectors/sync/dates')

const TEST_URL     = process.env.TEST_DATABASE_URL
const describeIfDb = TEST_URL ? describe : describe.skip

const MIGRATIONS = [
  '025_casino_players.sql',
  '028_casino_transactions.sql',
  '031_casino_transactions_timestamp.sql',
  '123_casino_players_platform.sql',
  '125_casino_sync_monitoring.sql',
]

// Considera ?host=/?hostaddr= (pisan al hostname) y PGHOST; ver tests/helpers.
const { assertLocalTestUrl } = require('../helpers/local-db-guard')

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TODAY = argToday(new Date())
const D     = n => addDays(TODAY, -n)   // D(1) = ayer (hora Argentina)

function mov(id, username, tipo, monto, daysAgo, extra = {}) {
  const fecha = D(daysAgo)
  return {
    id_rec:         id,
    username,
    tipo,
    monto,
    fecha,
    fecha_hora_utc: `${fecha}T15:00:00.000Z`,
    raw_detalles:   tipo === 'carga' ? 'Carga directa' : 'Retiro directo',
    ...extra,
  }
}

/** Conector que devuelve movimientos ya normalizados desde memoria. */
class FixtureConnector extends BaseCasinoConnector {
  constructor(platform, pool, fixtures = {}) {
    super({ name: platform, type: platform, baseUrl: 'http://fixture.invalid', endpoint: '/fixture' }, pool)
    this.fixtures = fixtures
  }
  async fetchTransactions(agente, desde, hasta) {
    const f = this.fixtures[agente]
    if (f instanceof Error) throw f
    const rows = typeof f === 'function' ? f(desde, hasta) : (f ?? [])
    return rows.filter(t => t.fecha >= desde && t.fecha <= hasta)
  }
  async normalizeTransactions(raw) { return raw.map(r => ({ ...r })) }
  async healthCheck() { return true }
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }

describeIfDb('sync de casino — integración PostgreSQL local', () => {
  jest.setTimeout(30_000)

  let admin
  let pool
  let schema

  beforeAll(async () => {
    assertLocalTestUrl(TEST_URL)
    schema = `casino_it_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    admin  = new Pool({ connectionString: TEST_URL, max: 1 })
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new Pool({ connectionString: TEST_URL, max: 10, options: `-c search_path=${schema}` })
    for (const file of MIGRATIONS) {
      const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', file), 'utf8')
      await pool.query(sql)
    }
  })

  afterAll(async () => {
    if (pool)  await pool.end()
    if (admin) {
      if (schema) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await admin.end()
    }
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE casino_sync_agent_ranges, casino_sync_cursors, casino_sync_runs,
                      casino_transactions, casino_players RESTART IDENTITY CASCADE`)
  })

  const player = async uname => {
    const { rows } = await pool.query(
      `SELECT username_lower, agente, platform, total_cargas::int AS cargas, total_retiros::int AS retiros,
              cant_cargas, cant_retiros, seg_monto
       FROM casino_players WHERE username_lower = $1`, [uname])
    return rows[0] ?? null
  }
  const txCount = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM casino_transactions')).rows[0].n

  const run = (opts, fixturesByPlatform) => runSync(
    { agentes: ['betcoin'], heartbeatMs: 60_000, politenessMs: 0, ...opts },
    {
      pool,
      log: silentLog,
      store: new SyncRunStore(pool, { instanceId: 'jest' }),
      createConnector: platform => new FixtureConnector(platform, pool, fixturesByPlatform[platform] ?? {}),
    },
  )

  it('repeating the same range 10 times leaves totals identical', async () => {
    const fixtures = { zeus: { betcoin: [
      mov('1', 'juan', 'carga', 1000, 3), mov('2', 'juan', 'retiro', 300, 2), mov('3', 'ana', 'carga', 500, 2),
    ] } }

    for (let i = 0; i < 10; i++) {
      const res = await run({ platform: 'zeus', mode: 'range', desde: D(5), hasta: TODAY }, fixtures)
      expect(res.exitCode).toBe(EXIT.SUCCESS)
    }

    expect(await txCount()).toBe(3)
    expect(await player('juan')).toMatchObject({ cargas: 1000, retiros: 300, cant_cargas: 1, cant_retiros: 1 })
    expect(await player('ana')).toMatchObject({ cargas: 500 })

    const runs = await pool.query(`SELECT status, tx_fetched, tx_inserted FROM casino_sync_runs ORDER BY started_at`)
    expect(runs.rows).toHaveLength(10)
    expect(runs.rows.every(r => r.status === 'success')).toBe(true)
    expect(runs.rows[0].tx_inserted).toBe(3)
    expect(runs.rows[9].tx_inserted).toBe(0)
    expect(runs.rows[9].tx_fetched).toBe(3)
  })

  it('a rollback leaves neither transactions nor inflated players, and a retry does not double', async () => {
    await pool.query(`INSERT INTO casino_players (username, agente, total_cargas, cant_cargas, seg_monto)
                      VALUES ('juan', 'betcoin', 1000, 1, 'medio')`)
    await pool.query(`INSERT INTO casino_transactions (platform, id_rec, fecha, agente, username, tipo, monto)
                      VALUES ('zeus', 1, $1, 'betcoin', 'juan', 'carga', 1000)`, [D(3)])

    class FailingRecompute extends FixtureConnector {
      async recomputePlayers() { throw new Error('boom after insert') }
    }
    const failing = new FailingRecompute('zeus', pool, { betcoin: [mov('1', 'juan', 'carga', 1000, 3), mov('2', 'juan', 'carga', 250, 1)] })
    await expect(failing.syncAgent('betcoin', D(5), TODAY)).rejects.toThrow('boom after insert')

    expect(await txCount()).toBe(1)
    expect(await player('juan')).toMatchObject({ cargas: 1000, seg_monto: 'medio' })

    const ok = new FixtureConnector('zeus', pool, failing.fixtures)
    await ok.syncAgent('betcoin', D(5), TODAY)
    await ok.syncAgent('betcoin', D(5), TODAY)
    expect(await player('juan')).toMatchObject({ cargas: 1250, cant_cargas: 2, seg_monto: 'medio' })
  })

  it('the same transaction ID on two platforms keeps both rows', async () => {
    const zeus  = new FixtureConnector('zeus',  pool, { betcoin: [mov('500', 'juan', 'carga', 100, 1)] })
    const bet30 = new FixtureConnector('bet30', pool, { btcuno:  [mov('500', 'juan', 'carga', 700, 1)] })
    await zeus.syncAgent('betcoin', D(2), TODAY)
    await bet30.syncAgent('btcuno', D(2), TODAY)

    const { rows } = await pool.query(`SELECT platform, id_rec::text FROM casino_transactions ORDER BY platform`)
    expect(rows).toEqual([{ platform: 'bet30', id_rec: '500' }, { platform: 'zeus', id_rec: '500' }])
    expect(await player('juan')).toMatchObject({ cargas: 800 })
  })

  it('usernames are aggregated case-insensitively into one player (D2 still global)', async () => {
    const zeus  = new FixtureConnector('zeus',  pool, { betcoin: [mov('1', 'Juan', 'carga', 100, 2)] })
    const bet30 = new FixtureConnector('bet30', pool, { btcuno:  [mov('1', 'JUAN', 'carga', 50, 1)] })
    await zeus.syncAgent('betcoin', D(3), TODAY)
    await bet30.syncAgent('btcuno', D(3), TODAY)

    const { rows } = await pool.query('SELECT username_lower FROM casino_players')
    expect(rows).toEqual([{ username_lower: 'juan' }])
    // agente/plataforma = los del movimiento más reciente
    expect(await player('juan')).toMatchObject({ cargas: 150, agente: 'btcuno', platform: 'bet30' })
  })

  it('recompute keeps history from other agents and legacy rows of the same player', async () => {
    await pool.query(`INSERT INTO casino_transactions (platform, id_rec, fecha, agente, username, tipo, monto)
                      VALUES (NULL, 9001, '2025-01-10', 'viejo', 'ana', 'carga', 4000),
                             ('bet30', 77, $1, 'btcdos', 'ana', 'retiro', 100)`, [D(10)])
    const zeus = new FixtureConnector('zeus', pool, { betcoin: [mov('1', 'ana', 'carga', 600, 1)] })
    await zeus.syncAgent('betcoin', D(2), TODAY)
    expect(await player('ana')).toMatchObject({ cargas: 4600, retiros: 100, cant_cargas: 2 })
  })

  it('id_rec = 0 is treated as "sin ID": no collapse with other ID-0 rows of other days, coverage limited', async () => {
    const fixtures = { zeus: { betcoin: [
      mov(0, 'p1', 'carga', 100, 2), mov(0, 'p1', 'carga', 100, 1), mov(0, 'p1', 'carga', 100, 1),
    ] } }
    const res = await run({ platform: 'zeus', mode: 'range', desde: D(3), hasta: TODAY }, fixtures)
    expect(res.exitCode).toBe(EXIT.SUCCESS)

    const { rows } = await pool.query('SELECT id_rec FROM casino_transactions')
    expect(rows).toHaveLength(2)                 // el tercero es indistinguible del segundo
    expect(rows.every(r => r.id_rec === null)).toBe(true)
    const range = (await pool.query('SELECT coverage, tx_without_id, tx_collapsed_without_id FROM casino_sync_agent_ranges')).rows[0]
    expect(range).toEqual({ coverage: 'limited', tx_without_id: 3, tx_collapsed_without_id: 1 })
  })

  it('completes fecha_hora_utc on re-sync and counts it as updated, not inserted', async () => {
    const sinHora = new FixtureConnector('zeus', pool, { betcoin: [mov('1', 'p1', 'carga', 10, 1, { fecha_hora_utc: null })] })
    const conHora = new FixtureConnector('zeus', pool, { betcoin: [mov('1', 'p1', 'carga', 10, 1)] })
    await sinHora.syncAgent('betcoin', D(2), TODAY)
    const s = await conHora.syncAgent('betcoin', D(2), TODAY)
    expect(s).toMatchObject({ insertedTxCount: 0, updatedTxCount: 1 })
  })

  it('unclassified legacy rows in the agent range fail closed with LEGACY_UNCLASSIFIED', async () => {
    await pool.query(`INSERT INTO casino_transactions (platform, id_rec, fecha, agente, username, tipo, monto)
                      VALUES (NULL, 42, $1, 'bigwin', 'x', 'carga', 1)`, [D(1)])
    const res = await run({ platform: 'zeus', mode: 'range', desde: D(3), hasta: TODAY, agentes: ['bigwin'] },
      { zeus: { bigwin: [mov('42', 'x', 'carga', 1, 1)] } })

    expect(res).toMatchObject({ status: 'failed', exitCode: EXIT.FAILED })
    expect(await txCount()).toBe(1)
    const r = (await pool.query('SELECT status, error_code FROM casino_sync_agent_ranges')).rows[0]
    expect(r).toEqual({ status: 'failed', error_code: 'LEGACY_UNCLASSIFIED' })
    const runRow = (await pool.query('SELECT status, finished_at FROM casino_sync_runs')).rows[0]
    expect(runRow.status).toBe('failed')
    expect(runRow.finished_at).not.toBeNull()
  })

  it('an ID shared with an unclassified legacy row of another agent also fails closed', async () => {
    await pool.query(`INSERT INTO casino_transactions (platform, id_rec, fecha, agente, username, tipo, monto)
                      VALUES (NULL, 777, '2025-05-05', 'otro', 'x', 'carga', 1)`)
    const zeus = new FixtureConnector('zeus', pool, { betcoin: [mov('777', 'juan', 'carga', 10, 1)] })
    await expect(zeus.syncAgent('betcoin', D(2), TODAY)).rejects.toMatchObject({ code: 'LEGACY_UNCLASSIFIED' })
    expect(await txCount()).toBe(1)
    expect(await player('juan')).toBeNull()
  })

  it('cursor: bootstrap → empty success advances → failure does not advance', async () => {
    const empty = { zeus: { betcoin: [] } }
    let res = await run({ platform: 'zeus', mode: 'auto' }, empty)
    expect(res.status).toBe('failed')      // sin cursor ni bootstrap
    expect((await pool.query('SELECT error_code FROM casino_sync_agent_ranges')).rows[0].error_code).toBe('CURSOR_MISSING')

    res = await run({ platform: 'zeus', mode: 'auto', bootstrapDesde: D(10) }, empty)
    expect(res.status).toBe('success')
    const cursor = async () => (await pool.query(
      `SELECT covered_from::text AS f, covered_through::text AS t FROM casino_sync_cursors WHERE platform = 'zeus' AND agente = 'betcoin'`)).rows[0]
    expect(await cursor()).toEqual({ f: D(10), t: D(1) })

    await pool.query(`UPDATE casino_sync_cursors SET covered_through = $1`, [D(4)])
    res = await run({ platform: 'zeus', mode: 'auto' }, { zeus: { betcoin: new Error('HTTP 500') } })
    expect(res.status).toBe('failed')
    expect(await cursor()).toEqual({ f: D(10), t: D(4) })

    res = await run({ platform: 'zeus', mode: 'auto' }, empty)
    expect(res.status).toBe('success')
    expect(await cursor()).toEqual({ f: D(10), t: D(1) })
  })

  it('a disjoint manual range does not move the cursor over the gap', async () => {
    await run({ platform: 'zeus', mode: 'range', desde: D(20), hasta: D(15) }, { zeus: { betcoin: [] } })
    await run({ platform: 'zeus', mode: 'range', desde: D(8),  hasta: D(5)  }, { zeus: { betcoin: [] } })
    const { rows } = await pool.query(`SELECT covered_from::text AS f, covered_through::text AS t FROM casino_sync_cursors`)
    expect(rows).toEqual([{ f: D(20), t: D(15) }])
  })

  it('platform lock: a second run of the same platform is skipped (exit 3) and recorded', async () => {
    const store = new SyncRunStore(pool)
    const lock  = await store.acquirePlatformLock('zeus')
    expect(lock.acquired).toBe(true)
    try {
      const res = await run({ platform: 'zeus', mode: 'range', desde: D(1), hasta: TODAY }, { zeus: { betcoin: [] } })
      expect(res).toMatchObject({ status: 'skipped', exitCode: EXIT.SKIPPED })
      // otra plataforma no queda bloqueada
      const other = await run({ platform: 'bet30', mode: 'range', desde: D(1), hasta: TODAY, agentes: ['btcuno'] }, { bet30: { btcuno: [] } })
      expect(other.status).toBe('success')
    } finally {
      await lock.release()
    }
    const again = await run({ platform: 'zeus', mode: 'range', desde: D(1), hasta: TODAY }, { zeus: { betcoin: [] } })
    expect(again.status).toBe('success')
    const statuses = (await pool.query(`SELECT status FROM casino_sync_runs WHERE platform = 'zeus' ORDER BY started_at`)).rows
    expect(statuses.map(r => r.status)).toEqual(['skipped', 'success'])
  })

  describe('run_id reuse', () => {
    const RID = '77777777-7777-4777-8777-777777777777'
    const rowOf = async () => (await pool.query(
      `SELECT status, instance_id, error_code, finished_at IS NOT NULL AS finished FROM casino_sync_runs WHERE run_id = $1`, [RID])).rows[0]

    it('adopts an API pre-registration with identical parameters', async () => {
      await pool.query(`INSERT INTO casino_sync_runs (run_id, platform, mode, triggered_by, requested_desde, requested_hasta,
                          requested_agents, status, instance_id)
                        VALUES ($1, 'zeus', 'range', 'api', $2, $3, ARRAY['betcoin'], 'running', NULL)`, [RID, D(2), TODAY])
      const res = await run({ platform: 'zeus', mode: 'range', desde: D(2), hasta: TODAY, runId: RID, triggeredBy: 'api' },
        { zeus: { betcoin: [] } })
      expect(res.status).toBe('success')
      expect(await rowOf()).toMatchObject({ status: 'success', instance_id: 'jest', finished: true })
    })

    it('does not touch an ACTIVE run with the same id (lock free or busy)', async () => {
      await pool.query(`INSERT INTO casino_sync_runs (run_id, platform, mode, status, instance_id)
                        VALUES ($1, 'zeus', 'auto', 'running', 'otro-host:42')`, [RID])

      const free = await run({ platform: 'zeus', mode: 'range', desde: D(1), hasta: TODAY, runId: RID }, { zeus: { betcoin: [] } })
      expect(free).toMatchObject({ status: 'failed', errorCode: 'RUN_ID_REUSED' })
      expect(await rowOf()).toMatchObject({ status: 'running', instance_id: 'otro-host:42', finished: false })

      const lock = await new SyncRunStore(pool).acquirePlatformLock('zeus')
      try {
        const busy = await run({ platform: 'zeus', mode: 'range', desde: D(1), hasta: TODAY, runId: RID }, { zeus: { betcoin: [] } })
        expect(busy).toMatchObject({ status: 'failed', errorCode: 'RUN_ID_REUSED' })
      } finally {
        await lock.release()
      }
      expect(await rowOf()).toMatchObject({ status: 'running', instance_id: 'otro-host:42', error_code: null })
    })

    it('does not touch a FINISHED run with the same id', async () => {
      await run({ platform: 'zeus', mode: 'range', desde: D(1), hasta: TODAY, runId: RID }, { zeus: { betcoin: [] } })
      const before = await rowOf()
      const again  = await run({ platform: 'zeus', mode: 'range', desde: D(1), hasta: TODAY, runId: RID }, { zeus: { betcoin: [] } })
      expect(again.errorCode).toBe('RUN_ID_REUSED')
      expect(await rowOf()).toEqual(before)
    })
  })

  it('stale running runs are closed as INTERRUPTED when a new run takes the lock', async () => {
    await pool.query(`INSERT INTO casino_sync_runs (run_id, platform, mode, status, started_at, heartbeat_at)
                      VALUES ('99999999-9999-4999-8999-999999999999', 'zeus', 'auto', 'running',
                              NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours')`)
    await run({ platform: 'zeus', mode: 'range', desde: D(1), hasta: TODAY }, { zeus: { betcoin: [] } })
    const r = (await pool.query(`SELECT status, error_code FROM casino_sync_runs WHERE run_id = '99999999-9999-4999-8999-999999999999'`)).rows[0]
    expect(r).toEqual({ status: 'failed', error_code: 'INTERRUPTED' })
  })

  it('concurrent recomputes of the same player from two platforms end with the full total', async () => {
    const zeusRows  = Array.from({ length: 20 }, (_, i) => mov(String(i + 1),   'dual', 'carga', 10, 1))
    const bet30Rows = Array.from({ length: 20 }, (_, i) => mov(String(i + 1), 'DUAL', 'carga', 1, 1))
    const zeus  = new FixtureConnector('zeus',  pool, { betcoin: zeusRows })
    const bet30 = new FixtureConnector('bet30', pool, { btcuno:  bet30Rows })

    await Promise.all([
      zeus.syncAgent('betcoin', D(2), TODAY),
      bet30.syncAgent('btcuno', D(2), TODAY),
      zeus.syncAgent('betcoin', D(2), TODAY),
      bet30.syncAgent('btcuno', D(2), TODAY),
    ])
    expect(await player('dual')).toMatchObject({ cargas: 220, cant_cargas: 40 })
  })

  it('RLS is enabled on the new tables', async () => {
    const { rows } = await pool.query(
      `SELECT c.relname, c.relrowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname LIKE 'casino_sync_%' AND c.relkind = 'r'
       ORDER BY 1`, [schema])
    expect(rows).toEqual([
      { relname: 'casino_sync_agent_ranges', relrowsecurity: true },
      { relname: 'casino_sync_cursors',      relrowsecurity: true },
      { relname: 'casino_sync_runs',         relrowsecurity: true },
    ])
  })
})
