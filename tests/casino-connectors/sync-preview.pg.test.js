'use strict'

/**
 * Preview vs. actual writer on PostgreSQL LOCAL, with synthetic fixtures only.
 * TEST_DATABASE_URL is mandatory; DATABASE_URL is never a connection fallback.
 *
 * Preview SQL explicitly uses public.*, so this suite creates a separate random
 * database, rather than relying on the search_path isolation of other suites.
 * Projection-parity writes are deliberately rolled back from afterWrite. The
 * bonus retry cases commit only inside this disposable synthetic database to
 * verify idempotency across retries. Serial sequences may advance on writes;
 * the preview itself must
 * leave tables AND sequence state unchanged. No reports containing rows are
 * written to disk. The local role needs permission to CREATE/DROP DATABASE.
 */

const fs = require('fs')
const path = require('path')
const { randomBytes } = require('crypto')
const { Client, Pool } = require('pg')
const { assertLocalTestUrl, isLocalHost } = require('../helpers/local-db-guard')
const { BaseCasinoConnector } = require('../../src/casino-connectors/base/BaseCasinoConnector')
const { ZeusConnector } = require('../../src/casino-connectors/zeus/ZeusConnector')
const { Bet30Connector } = require('../../src/casino-connectors/bet30/Bet30Connector')
const { SyncRunStore } = require('../../src/casino-connectors/sync/SyncRunStore')
const { SyncError } = require('../../src/casino-connectors/sync/sanitize')
const { advanceCursor } = require('../../src/casino-connectors/sync/cursor')
const { runPreview } = require('../../src/casino-connectors/sync/preview')

const TEST_URL = process.env.TEST_DATABASE_URL
const describeIfDb = TEST_URL ? describe : describe.skip
const NOW = new Date('2026-09-15T12:00:00.000Z')
const DAY = '2026-09-12'
const RUN_ID = '00000000-0000-4000-8000-000000000001'
const METRICS = ['total_cargas', 'total_retiros', 'cant_cargas', 'cant_retiros']
const MIGRATIONS = [
  '025_casino_players.sql', '028_casino_transactions.sql',
  '031_casino_transactions_timestamp.sql', '123_casino_players_platform.sql',
  '125_casino_sync_monitoring.sql',
]
const silentLog = { info() {}, warn() {}, error() {}, debug() {} }
const scope = extra => ({ preview: true, platform: 'zeus', mode: 'range',
  agentes: ['betcoin'], desde: DAY, hasta: DAY, ...extra })
const amounts = (cargas, retiros, countCargas, countRetiros) => ({
  total_cargas: String(cargas), total_retiros: String(retiros),
  cant_cargas: String(countCargas), cant_retiros: String(countRetiros),
})
function mov(id, username, monto, extra = {}) {
  return { id_rec: String(id), username, tipo: 'carga', monto, fecha: DAY,
    fecha_hora_utc: `${DAY}T16:00:00.000Z`, raw_detalles: 'SYNTHETIC_DETAIL_PRIVATE', ...extra }
}

class FixtureConnector extends BaseCasinoConnector {
  constructor(platform, pool, rows) {
    super({ name: platform, type: platform, baseUrl: 'http://fixture.invalid', endpoint: '/fixture' }, pool)
    this.log = silentLog
    this.authenticate = jest.fn(async () => {})
    this.fetchTransactions = jest.fn(async () => rows.map(row => ({ ...row })))
  }
  async normalizeTransactions(raw) { return raw.map(row => ({ ...row })) }
}

// Use the real normalizer and persistence methods without invoking constructors
// that read provider credentials. Only provider I/O is replaced with fixtures.
function rawProviderFixture(platform, pool, raw) {
  const Connector = platform === 'bet30' ? Bet30Connector : ZeusConnector
  return Object.assign(Object.create(Connector.prototype), {
    config: { name: platform, type: platform, baseUrl: 'http://fixture.invalid', endpoint: '/fixture' },
    pool, log: silentLog,
    authenticate: jest.fn(async () => {}),
    fetchTransactions: jest.fn(async () => raw.map(row => ({ ...row }))),
  })
}

function localPoolOptions(url, expectedDatabase) {
  assertLocalTestUrl(url)
  const options = { connectionString: url, max: 1, connectionTimeoutMillis: 5000, query_timeout: 20000 }
  // Validate pg's effective routing too: URL query parameters override pathname.
  // Constructing a Client does not open a connection.
  const effective = new Client(options).connectionParameters
  if (!isLocalHost(effective.host)) throw new Error('Effective fixture host must be local')
  if (expectedDatabase && effective.database !== expectedDatabase) {
    throw new Error('Effective fixture database does not match the isolated database')
  }
  return options
}

const SNAPSHOT_SQL = `SELECT
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id), '[]'::jsonb) FROM public.casino_transactions t) AS transactions,
  (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY username_lower), '[]'::jsonb) FROM public.casino_players p) AS players,
  (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY run_id), '[]'::jsonb) FROM public.casino_sync_runs r) AS runs,
  (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id), '[]'::jsonb) FROM public.casino_sync_agent_ranges r) AS ranges,
  (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY platform, agente), '[]'::jsonb) FROM public.casino_sync_cursors c) AS cursors`

function tablesOnly(snapshot) {
  const { sequences, ...tables } = snapshot
  return tables
}

describeIfDb('casino preview — isolated PostgreSQL projection parity', () => {
  jest.setTimeout(30000)
  let admin, pool, database, created = false

  beforeAll(async () => {
    const adminOptions = localPoolOptions(TEST_URL)
    database = `monitoring_preview_${randomBytes(6).toString('hex')}`
    if (!/^monitoring_preview_[a-f0-9]{12}$/.test(database)) throw new Error('Invalid synthetic database name')
    const url = new URL(TEST_URL)
    url.pathname = `/${database}`
    // pg accepts dbname/database in URLs. They must never route fixture writes
    // back to the caller's existing database after replacing the pathname.
    url.searchParams.delete('database')
    url.searchParams.delete('dbname')
    const fixtureOptions = localPoolOptions(url.toString(), database)
    admin = new Pool(adminOptions)
    await admin.query(`CREATE DATABASE "${database}"`)
    created = true
    pool = new Pool(fixtureOptions)
    await pool.query('SET search_path TO public')
    const identity = (await pool.query('SELECT current_database() AS database, current_schema() AS schema')).rows[0]
    expect(identity).toEqual({ database, schema: 'public' })
    for (const filename of MIGRATIONS) {
      const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', filename), 'utf8')
      await pool.query(sql)
    }
  })

  afterAll(async () => {
    try {
      if (pool) await pool.end()
      if (created && admin && /^monitoring_preview_[a-f0-9]{12}$/.test(database)) {
        await admin.query(`DROP DATABASE "${database}"`)
      }
    } finally {
      if (admin) await admin.end()
    }
  })

  beforeEach(async () => {
    // pool can only connect to the newly created DB checked in beforeAll.
    await pool.query(`TRUNCATE public.casino_sync_agent_ranges, public.casino_sync_cursors,
      public.casino_sync_runs, public.casino_transactions, public.casino_players
      RESTART IDENTITY CASCADE`)
  })

  async function snapshot(db = pool) {
    const state = (await db.query(SNAPSHOT_SQL)).rows[0]
    state.sequences = {
      transactions: (await db.query('SELECT last_value::text, is_called FROM public.casino_transactions_id_seq')).rows[0],
      ranges: (await db.query('SELECT last_value::text, is_called FROM public.casino_sync_agent_ranges_id_seq')).rows[0],
    }
    return state
  }

  async function seedTx({ idRec, username, monto, tipo = 'carga', fecha = DAY,
    utc = `${DAY}T15:00:00.000000Z`, agente = 'betcoin', platform = 'zeus' }) {
    return (await pool.query(`INSERT INTO public.casino_transactions
      (id_rec, username, monto, tipo, fecha, fecha_hora_utc, agente, platform)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text`,
    [idRec, username, monto, tipo, fecha, utc, agente, platform])).rows[0].id
  }

  async function seedPlayer(username, { cargas = 0, retiros = 0, countCargas = 0, countRetiros = 0,
    platform = 'bet30', agente = 'old-agent' } = {}) {
    await pool.query(`INSERT INTO public.casino_players
      (username, agente, platform, total_cargas, total_retiros, cant_cargas, cant_retiros,
       fecha_primera, fecha_ultima, seg_monto, seg_actividad)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-09-01','2026-09-02','medio','regular')`,
    [username, agente, platform, cargas, retiros, countCargas, countRetiros])
  }

  async function preview(rows, extra = {}, makeConnector = (platform, db, fixtureRows) => new FixtureConnector(platform, db, fixtureRows)) {
    const before = await snapshot()
    const opts = scope(extra)
    const connector = makeConnector(opts.platform, null, rows)
    const writes = ['syncAgent', 'persistSync', 'writeTransactions', 'recomputePlayers']
      .map(name => jest.spyOn(connector, name))
    const queryCalls = []
    const previewPool = {
      connect: jest.fn(async () => {
        const client = await pool.connect()
        return {
          query: (sql, params) => { queryCalls.push(String(sql)); return client.query(sql, params) },
          release: error => client.release(error),
        }
      }),
    }
    const report = await runPreview(opts, {
      pool: previewPool, now: () => new Date(NOW), createConnector: () => connector,
    })
    expect(await snapshot()).toEqual(before)
    writes.forEach(spy => expect(spy).not.toHaveBeenCalled())
    for (const sql of queryCalls) {
      expect(sql).toMatch(/^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SHOW |SET LOCAL |SELECT |ROLLBACK)/)
      expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|nextval|advisory|FOR UPDATE/i)
    }
    const output = JSON.stringify(report)
    expect(output).not.toMatch(/SYNTHETIC_DETAIL_PRIVATE|PRIVATE_PLAYER|raw_detalles|fecha_hora_utc|connectionString|postgresql:\/\//)
    return { report, connector, queryCalls, previewPool }
  }

  async function actualRolledBack(rows, { moveCursor = false } = {}) {
    const before = await snapshot()
    const connector = new FixtureConnector('zeus', pool, rows)
    const prepared = connector.prepareTransactions(rows)
    const store = new SyncRunStore(pool)
    const sentinel = new Error('SYNTHETIC_EXPECTED_ROLLBACK')
    let captured
    await expect(connector.persistSync('betcoin', prepared, {
      beforeWrite: async client => {
        const n = await store.countUnclassifiedLegacy(client, 'betcoin', DAY, DAY)
        if (n > 0) throw new SyncError('LEGACY_UNCLASSIFIED', 'Synthetic legacy range')
      },
      afterWrite: async (client, written) => {
        let cursorProjection
        if (moveCursor) {
          const current = await store.getCursor('zeus', 'betcoin', client, { forUpdate: true })
          const next = advanceCursor(current, { desde: DAY, hasta: DAY, fetchStartedAt: NOW })
          if (next.moved) await store.saveCursor(client, 'zeus', 'betcoin', next.cursor, RUN_ID)
          cursorProjection = { before: current, ...next }
        }
        // Independent SQL over the actual rows the writer has recomputed.
        const totals = (await client.query(`SELECT
          COALESCE(SUM(cp.total_cargas),0)::text AS total_cargas,
          COALESCE(SUM(cp.total_retiros),0)::text AS total_retiros,
          COALESCE(SUM(cp.cant_cargas),0)::text AS cant_cargas,
          COALESCE(SUM(cp.cant_retiros),0)::text AS cant_retiros
          FROM public.casino_players cp WHERE cp.username_lower = ANY($1::text[])
          AND EXISTS (SELECT 1 FROM public.casino_transactions ct
            WHERE LOWER(ct.username) = cp.username_lower AND LOWER(ct.username) <> LOWER(ct.agente))`,
        [prepared.usernames])).rows[0]
        captured = { written, totals, cursorProjection, state: await snapshot(client) }
        throw sentinel
      },
    })).rejects.toBe(sentinel)
    expect(captured).toBeDefined()
    expect(tablesOnly(await snapshot())).toEqual(tablesOnly(before))
    // nextval is intentionally not asserted after writer ROLLBACK: PostgreSQL
    // sequences are nontransactional, even though all synthetic table rows undo.
    return captured
  }

  function compareC(report, actual) {
    expect(report.status).toBe('complete')
    expect(report.exitCode).toBe(0)
    expect(report.impact.aggregates.C_projected).toEqual(actual.totals)
    expect(actual.written).toEqual({
      inserted: report.impact.transactions.inserted,
      updated: report.impact.transactions.timestamp_updated,
      players: report.impact.players.recomputed,
    })
    expect(Object.keys(actual.totals).sort()).toEqual([...METRICS].sort())
  }

  it('matches A/B/C across case variants and platforms, with historical drift, an orphan and an excluded agent target', async () => {
    await seedPlayer('PRIVATE_PLAYER_Alice', { cargas: 1000, retiros: 50, countCargas: 10, countRetiros: 1 })
    await seedPlayer('PRIVATE_PLAYER_Orphan', { cargas: 500, countCargas: 5 })
    await seedPlayer('betcoin', { cargas: 777, countCargas: 7 })
    await seedTx({ idRec: '101', username: 'PRIVATE_PLAYER_ALICE', monto: 100,
      fecha: '2026-09-01', utc: null, agente: 'old-agent', platform: null })
    await seedTx({ idRec: '102', username: 'private_player_alice', monto: 20, tipo: 'retiro',
      fecha: '2026-09-02', utc: null, agente: 'btcuno', platform: 'bet30' })
    const batch = [mov('901', 'Private_Player_AliCe', 30), mov('902', 'PRIVATE_PLAYER_Bob', 50),
      mov('903', 'private_player_orphan', 25), mov('904', 'BETCOIN', 999)]
    const { report } = await preview(batch)
    expect(report.impact.aggregates).toEqual({
      A_current: amounts(1500, 50, 15, 1),
      B_existing_source: amounts(100, 20, 1, 1),
      C_projected: amounts(205, 20, 4, 1),
    })
    expect(report.impact.deltas).toEqual({
      historical_recompute: amounts(-1400, -30, -14, 0),
      new_batch: amounts(105, 0, 3, 0), effective: amounts(-1295, -30, -11, 0),
    })
    expect(report.impact.players).toMatchObject({ targets: 4, recomputed: 3, existing: 2, created: 1, unchanged_targets: 1 })
    const actual = await actualRolledBack(batch)
    compareC(report, actual)
    const alice = actual.state.players.find(p => p.username_lower === 'private_player_alice')
    expect(alice).toMatchObject({ username: 'PRIVATE_PLAYER_Alice', total_cargas: 130,
      total_retiros: 20, cant_cargas: 2, cant_retiros: 1, platform: 'zeus', agente: 'betcoin',
      seg_monto: 'medio', seg_actividad: 'regular' })
    expect(actual.state.players.find(p => p.username_lower === 'betcoin')).toMatchObject({ total_cargas: 777, cant_cargas: 7 })
    expect(actual.state.transactions).toHaveLength(6)
  })

  it('matches timestamp-only conflict updates and duplicate IDs, without overwriting provider revisions or another platform', async () => {
    await seedPlayer('PRIVATE_PLAYER_Alice', { cargas: 300, countCargas: 2, agente: 'btcuno' })
    await seedTx({ idRec: '7', username: 'PRIVATE_PLAYER_Alice', monto: 100, utc: null })
    await seedTx({ idRec: '7', username: 'private_player_alice', monto: 200, platform: 'bet30', agente: 'btcuno' })
    const incoming = mov('7', 'PRIVATE_PLAYER_ALICE', 999)
    const batch = [incoming, { ...incoming }]
    const { report } = await preview(batch)
    expect(report.batch.duplicate_ids).toBe(1)
    expect(report.impact.transactions).toEqual({ inserted: 0, timestamp_updated: 1, unchanged: 0, provider_revisions_not_applied: 1 })
    expect(report.impact.players).toMatchObject({ platform_changed: 1, agent_changed: 1 })
    expect(report.impact.aggregates.C_projected).toEqual(amounts(300, 0, 2, 0))
    const actual = await actualRolledBack(batch)
    compareC(report, actual)
    expect(actual.state.transactions.find(t => t.platform === 'zeus')).toMatchObject({ monto: 100, username: 'PRIVATE_PLAYER_Alice' })
    expect(actual.state.transactions.find(t => t.platform === 'bet30')).toMatchObject({ monto: 200 })
    // A timestamp that already exists must not be replaced on a later retry.
    await pool.query("UPDATE public.casino_transactions SET fecha_hora_utc = $1 WHERE platform = 'zeus'", [`${DAY}T14:00:00Z`])
    const retry = (await preview([incoming])).report
    expect(retry.impact.transactions).toMatchObject({ inserted: 0, timestamp_updated: 0, unchanged: 1 })
    compareC(retry, await actualRolledBack([incoming]))
  })

  it('blocks global NULL-platform ID collisions outside the requested range and range legacy before provider calls', async () => {
    await seedTx({ idRec: '900', username: 'PRIVATE_PLAYER_Other', monto: 10,
      fecha: '2026-01-01', utc: null, agente: 'bigwin', platform: null })
    const batch = [mov('900', 'PRIVATE_PLAYER_Alice', 20)]
    const globalCollision = await preview(batch)
    expect(globalCollision.report).toMatchObject({ status: 'blocked', error_code: 'LEGACY_ID_UNCLASSIFIED', impact: null })
    expect(globalCollision.connector.fetchTransactions).toHaveBeenCalledTimes(1)
    const writer = new FixtureConnector('zeus', pool, batch)
    const before = await snapshot()
    await expect(writer.persistSync('betcoin', writer.prepareTransactions(batch))).rejects.toMatchObject({ code: 'LEGACY_UNCLASSIFIED' })
    expect(await snapshot()).toEqual(before)
    await seedTx({ idRec: '901', username: 'PRIVATE_PLAYER_Range', monto: 10, utc: null,
      agente: 'BETCOIN', platform: null })
    const rangeCollision = await preview([mov('999', 'PRIVATE_PLAYER_Alice', 20)])
    expect(rangeCollision.report).toMatchObject({ status: 'blocked', error_code: 'LEGACY_RANGE_UNCLASSIFIED', impact: null })
    expect(rangeCollision.connector.authenticate).not.toHaveBeenCalled()
    expect(rangeCollision.connector.fetchTransactions).not.toHaveBeenCalled()
  })

  it('preserves NULL-platform COALESCE and exact microsecond/ID ordering, and blocks indeterminate new-ID metadata ties', async () => {
    await seedPlayer('PRIVATE_PLAYER_Alice', { cargas: 60, countCargas: 3, agente: 'old-agent' })
    await seedTx({ idRec: '21', username: 'PRIVATE_PLAYER_Alice', monto: 10, fecha: '2026-09-13',
      utc: '2026-09-13T15:00:00.123456Z', agente: 'tie-lower-id', platform: 'zeus' })
    const winner = await seedTx({ idRec: '22', username: 'PRIVATE_PLAYER_Alice', monto: 20, fecha: '2026-09-13',
      utc: '2026-09-13T15:00:00.123456Z', agente: 'legacy-winner', platform: null })
    // Higher physical ID, but one microsecond older: timestamp precedes id in ORDER BY.
    await seedTx({ idRec: '23', username: 'PRIVATE_PLAYER_Alice', monto: 30, fecha: '2026-09-13',
      utc: '2026-09-13T15:00:00.123455Z', agente: 'older-microsecond', platform: 'zeus' })
    const batch = [mov('24', 'PRIVATE_PLAYER_ALICE', 40)]
    const { report } = await preview(batch)
    expect(report.impact.players).toMatchObject({ agent_changed: 1, platform_changed: 0 })
    const actual = await actualRolledBack(batch)
    compareC(report, actual)
    expect(actual.state.players[0]).toMatchObject({ agente: 'legacy-winner', platform: 'bet30', total_cargas: 100, cant_cargas: 4 })
    expect(actual.state.transactions.find(t => String(t.id) === winner).platform).toBeNull()
    // Reuse the known scope day to create a tie involving an as-yet unallocated id.
    await seedPlayer('PRIVATE_PLAYER_Tie', { cargas: 10, countCargas: 1 })
    await seedTx({ idRec: '31', username: 'PRIVATE_PLAYER_Tie', monto: 10,
      utc: `${DAY}T16:00:00.000000Z`, agente: 'btcuno', platform: 'bet30' })
    const tied = (await preview([mov('32', 'PRIVATE_PLAYER_Tie', 20)])).report
    expect(tied).toMatchObject({ status: 'blocked', error_code: 'METADATA_TIE_INDETERMINATE', impact: null })
  })

  it('projects empty-batch cursor establishment, extension and disjoint ranges without persisting any run or cursor', async () => {
    await pool.query(`INSERT INTO public.casino_sync_runs
      (run_id, platform, mode, status, finished_at) VALUES ($1,'zeus','range','success',$2)`, [RUN_ID, NOW])
    const cases = [
      { before: null, reason: 'established', moved: true, next: { coveredFrom: DAY, coveredThrough: DAY } },
      { before: { coveredFrom: '2026-09-10', coveredThrough: '2026-09-11' }, reason: 'extended', moved: true,
        next: { coveredFrom: '2026-09-10', coveredThrough: DAY } },
      { before: { coveredFrom: '2026-09-08', coveredThrough: '2026-09-09' }, reason: 'disjoint', moved: false,
        next: { coveredFrom: '2026-09-08', coveredThrough: '2026-09-09' } },
    ]
    for (const item of cases) {
      await pool.query('DELETE FROM public.casino_sync_cursors')
      if (item.before) await pool.query(`INSERT INTO public.casino_sync_cursors
        (platform, agente, covered_from, covered_through, last_run_id) VALUES ('zeus','betcoin',$1,$2,$3)`,
      [item.before.coveredFrom, item.before.coveredThrough, RUN_ID])
      const { report } = await preview([])
      expect(report.cursor_projection).toEqual({ before: item.before, cursor: item.next, moved: item.moved, reason: item.reason })
      expect(report.impact.transactions).toMatchObject({ inserted: 0, timestamp_updated: 0 })
      expect(report.impact.players.recomputed).toBe(0)
      const actual = await actualRolledBack([], { moveCursor: true })
      compareC(report, actual)
      expect(actual.cursorProjection).toEqual(report.cursor_projection)
      expect(actual.state.cursors[0]).toMatchObject({ covered_from: item.next.coveredFrom, covered_through: item.next.coveredThrough })
    }
    const openDay = await preview([], { desde: '2026-09-15', hasta: '2026-09-15' })
    expect(openDay.report).toMatchObject({ status: 'blocked', exitCode: 2, error_code: 'PREVIEW_SCOPE_INVALID' })
    expect(openDay.previewPool.connect).not.toHaveBeenCalled()
    expect(openDay.connector.authenticate).not.toHaveBeenCalled()
  })
  it('zeus normalizes bonuses as deposits and preserves exact totals after ten committed retries', async () => {
    const platform = 'zeus'
    const agente = 'betcoin'
    const extra = { platform, agentes: [agente] }
    const base = { username: 'PRIVATE_PLAYER_Bonus', creator_username: agente, fecha: `${DAY}T15:00:00.000Z` }
    const firstBonus = { ...base, id: '7001', valor: '-125.4', detalles: 'Bono de bienvenida' }
    const raw = [
      firstBonus,
      { ...base, id: '7002', valor: '74.6', detalles: 'BONO promocional' },
      { ...base, id: '7003', valor: '200', detalles: 'Carga directa con bono' },
      { ...base, id: '7004', valor: '-40.2', detalles: 'Retiro de bono' },
      { ...firstBonus },
      { ...base, id: '7005', valor: '999', detalles: 'Bono indirecto' },
    ]
    const writer = rawProviderFixture(platform, pool, raw)
    const normalized = await writer.normalizeWithStats(raw)
    expect(normalized).toMatchObject({ invalid: 0, excluded: 1 })
    expect(normalized.rows.map(row => [row.id_rec, row.tipo, row.monto, row.fecha, row.fecha_hora_utc, row.raw_detalles])).toEqual([
      ['7001', 'carga', 125, DAY, base.fecha, 'Bono de bienvenida'],
      ['7002', 'carga', 75, DAY, base.fecha, 'BONO promocional'],
      ['7003', 'carga', 200, DAY, base.fecha, 'Carga directa con bono'],
      ['7004', 'retiro', 40, DAY, base.fecha, 'Retiro de bono'],
      ['7001', 'carga', 125, DAY, base.fecha, 'Bono de bienvenida'],
    ])
    const initial = (await preview(raw, extra, rawProviderFixture)).report
    expect(initial).toMatchObject({ status: 'complete', exitCode: 0 })
    expect(initial.batch).toMatchObject({ fetched: 6, normalized: 5, excluded: 1, invalid: 0, duplicate_ids: 1, without_id: 0 })
    expect(initial.impact.aggregates).toEqual({
      A_current: amounts(0, 0, 0, 0), B_existing_source: amounts(0, 0, 0, 0),
      C_projected: amounts(400, 40, 3, 1),
    })
    expect(initial.impact.transactions).toEqual({ inserted: 4, timestamp_updated: 0, unchanged: 0, provider_revisions_not_applied: 0 })

    // First write + ten genuine retries on already committed synthetic rows.
    // No real provider, run registration, segmentation or external DB is involved.
    for (let attempt = 0; attempt <= 10; attempt++) {
      const current = await writer.normalizeWithStats(raw)
      const written = await writer.persistSync(agente, writer.prepareTransactions(current.rows))
      expect(written).toEqual({ inserted: attempt === 0 ? 4 : 0, updated: 0, players: 1 })
      const actual = (await pool.query(`SELECT total_cargas::text, total_retiros::text,
        cant_cargas::text, cant_retiros::text FROM public.casino_players
        WHERE username_lower = 'private_player_bonus'`)).rows
      expect(actual).toEqual([initial.impact.aggregates.C_projected])
      expect((await pool.query('SELECT COUNT(*)::text AS n FROM public.casino_transactions')).rows[0].n).toBe('4')
    }
    const stored = (await pool.query(`SELECT id_rec::text, tipo, monto::text, raw_detalles, platform,
      fecha::text, to_char(fecha_hora_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS utc
      FROM public.casino_transactions ORDER BY id_rec`)).rows
    expect(stored).toEqual([
      { id_rec: '7001', tipo: 'carga', monto: '125', raw_detalles: 'Bono de bienvenida', platform, fecha: DAY, utc: base.fecha },
      { id_rec: '7002', tipo: 'carga', monto: '75', raw_detalles: 'BONO promocional', platform, fecha: DAY, utc: base.fecha },
      { id_rec: '7003', tipo: 'carga', monto: '200', raw_detalles: 'Carga directa con bono', platform, fecha: DAY, utc: base.fecha },
      { id_rec: '7004', tipo: 'retiro', monto: '40', raw_detalles: 'Retiro de bono', platform, fecha: DAY, utc: base.fecha },
    ])
    const replay = (await preview(raw, extra, rawProviderFixture)).report
    expect(replay).toMatchObject({ status: 'complete', exitCode: 0 })
    expect(replay.impact.transactions).toEqual({ inserted: 0, timestamp_updated: 0, unchanged: 4, provider_revisions_not_applied: 0 })
    expect(replay.impact.aggregates).toEqual({
      A_current: amounts(400, 40, 3, 1), B_existing_source: amounts(400, 40, 3, 1),
      C_projected: amounts(400, 40, 3, 1),
    })
    expect(replay.impact.deltas.effective).toEqual(amounts(0, 0, 0, 0))
    // A bonus does not bypass the existing guard for duplicate IDs with
    // different content. Each preview call also checks table/sequence parity.
    const conflict = (await preview([...raw, { ...firstBonus, valor: '-130' }], extra, rawProviderFixture)).report
    expect(conflict).toMatchObject({ status: 'blocked', error_code: 'DUPLICATE_ID_CONTENT_CONFLICT', impact: null })
    const state = await snapshot()
    expect(state.runs).toEqual([])
    expect(state.ranges).toEqual([])
    expect(state.cursors).toEqual([])
    expect(writer.authenticate).not.toHaveBeenCalled()
    expect(writer.fetchTransactions).not.toHaveBeenCalled()
  })

  it('bet30 blocks an unrecognized bonus without changing rows, sequences or coverage, and retains carga/retiro classification', async () => {
    const platform = 'bet30'
    const agente = 'btcuno'
    const extra = { platform, agentes: [agente] }
    const username = 'PRIVATE_PLAYER_Bonus'
    await seedPlayer(username, { cargas: 10, countCargas: 1, platform, agente })
    await seedTx({ idRec: '7100', username, monto: 10, platform, agente })
    await pool.query(`INSERT INTO public.casino_sync_runs
      (run_id, platform, mode, status, finished_at) VALUES ($1,'bet30','range','success',$2)`, [RUN_ID, NOW])
    await pool.query(`INSERT INTO public.casino_sync_cursors
      (platform, agente, covered_from, covered_through, last_run_id)
      VALUES ('bet30','btcuno','2026-09-10','2026-09-11',$1)`, [RUN_ID])
    const base = { username, creator_username: agente, fecha: `${DAY}T16:00:00.000Z` }
    const recognized = [
      { ...base, id: '7102', valor: '200', detalles: 'Carga directa con bono' },
      { ...base, id: '7103', valor: '-40.2', detalles: 'Retiro de bono' },
    ]
    const raw = [
      { ...base, id: '7101', valor: '125', detalles: 'Bono de bienvenida' },
      ...recognized,
      { ...base, id: '7104', valor: '999', detalles: 'Bono indirecto' },
    ]
    const connector = rawProviderFixture(platform, null, raw)
    const normalized = await connector.normalizeWithStats(raw)
    expect(normalized).toMatchObject({ invalid: 1, excluded: 1 })
    expect(normalized.rows.map(row => [row.id_rec, row.tipo, row.monto, row.raw_detalles])).toEqual([
      ['7102', 'carga', 200, 'Carga directa con bono'],
      ['7103', 'retiro', 40, 'Retiro de bono'],
    ])
    // The real inherited normalizer must fail closed for Bet30 bonuses. The
    // preview helper checks all five tables, both sequences and writer spies.
    const before = await snapshot()
    const blocked = (await preview(raw, extra, rawProviderFixture)).report
    expect(blocked).toMatchObject({ status: 'blocked', error_code: 'INVALID_TRANSACTIONS', impact: null })
    expect(blocked.batch).toMatchObject({ fetched: 4, normalized: 2, excluded: 1, invalid: 1 })
    expect(blocked.cursor_projection).toBeUndefined()
    expect(await snapshot()).toEqual(before)

    // Existing recognized transaction types remain usable, even when their
    // descriptions mention a bonus; the preview still cannot advance coverage.
    const allowed = (await preview(recognized, extra, rawProviderFixture)).report
    expect(allowed).toMatchObject({ status: 'complete', exitCode: 0 })
    expect(allowed.impact.aggregates).toEqual({
      A_current: amounts(10, 0, 1, 0), B_existing_source: amounts(10, 0, 1, 0),
      C_projected: amounts(210, 40, 2, 1),
    })
    expect(allowed.cursor_projection).toEqual({
      before: { coveredFrom: '2026-09-10', coveredThrough: '2026-09-11' },
      cursor: { coveredFrom: '2026-09-10', coveredThrough: DAY },
      moved: true, reason: 'extended',
    })
    expect(await snapshot()).toEqual(before)
    expect(connector.authenticate).not.toHaveBeenCalled()
    expect(connector.fetchTransactions).not.toHaveBeenCalled()
  })

})
