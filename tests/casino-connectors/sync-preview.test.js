'use strict'

const { BaseCasinoConnector } = require('../../src/casino-connectors/base/BaseCasinoConnector')
const { SyncError } = require('../../src/casino-connectors/sync/sanitize')
const { parseSyncArgs } = require('../../src/casino-connectors/sync/cli-args')
const { runPreview, projectImpact, previewPoolOptions, SQL, LIMITS } = require('../../src/casino-connectors/sync/preview')

const NOW = new Date('2026-09-15T12:00:00.000Z')
const DAY = '2026-09-14'
const SCOPE = { preview: true, mode: 'range', platform: 'zeus', agentes: ['betcoin'], desde: DAY, hasta: DAY }
const CLI = ['--preview', '--platform=zeus', '--agentes=betcoin', `--desde=${DAY}`, `--hasta=${DAY}`]
const parse = args => parseSyncArgs(args, { now: NOW })
function provider(overrides = {}) {
  return { id_rec: '100', username: 'PrivatePlayer', tipo: 'carga', monto: 50,
    fecha: DAY, fecha_hora_utc: `${DAY}T15:00:00.000Z`, raw_detalles: 'private provider details', ...overrides }
}
function stored(overrides = {}) {
  const row = { id: '1', id_rec: '1', username: 'PrivatePlayer', agente: 'betcoin', platform: null,
    tipo: 'carga', monto: '100', fecha: '2026-08-01', fecha_hora_utc: null, ...overrides }
  return { ...row, uname: row.username.toLowerCase(), eligible: row.username.toLowerCase() !== row.agente.toLowerCase() }
}
function player(overrides = {}) {
  return { username_lower: 'privateplayer', agente: 'betcoin', platform: 'zeus',
    total_cargas: '1000', total_retiros: '0', cant_cargas: '10', cant_retiros: '0',
    fecha_primera: '2026-08-01', fecha_ultima: '2026-08-01', ...overrides }
}
class FixtureConnector extends BaseCasinoConnector {
  constructor(raw, normalization) {
    super({ name: 'zeus', type: 'zeus', baseUrl: 'http://fixture.invalid', endpoint: '/fixture' }, null)
    this.authenticate = jest.fn(async () => {})
    this.fetchTransactions = jest.fn(async () => raw)
    this.normalizeTransactions = jest.fn(async rows => rows.map(row => ({ ...row })))
    if (normalization) this.normalizeWithStats = jest.fn(async () => normalization)
    this.syncAgent = jest.fn(() => { throw Error('WRITE PATH USED') })
    this.persistSync = jest.fn(() => { throw Error('WRITE PATH USED') })
    this.writeTransactions = jest.fn(() => { throw Error('WRITE PATH USED') })
    this.recomputePlayers = jest.fn(() => { throw Error('WRITE PATH USED') })
  }
}
function fixture({ raw = [provider()], transactions = [], players = [], cursor = null,
  readOnly = true, isolation = true, caseMismatch = false, normalization,
  historyOverride, secondLegacyConflict = false, rollbackFails = false } = {}) {
  const connector = new FixtureConnector(raw, normalization)
  let active = false, legacyReads = 0
  const client = {
    release: jest.fn(),
    query: jest.fn(async (sql, params = []) => {
      if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') { active = true; return { rows: [] } }
      if (sql === 'ROLLBACK') { if (rollbackFails) throw Error('private rollback detail'); active = false; return { rows: [] } }
      if (!active) throw Error('QUERY OUTSIDE READ-ONLY TRANSACTION')
      if (sql === 'SHOW transaction_read_only') return { rows: [{ transaction_read_only: readOnly ? 'on' : 'off' }] }
      if (sql === 'SHOW transaction_isolation') return { rows: [{ transaction_isolation: isolation ? 'repeatable read' : 'read committed' }] }
      if (sql.startsWith('SET LOCAL statement_timeout')) return { rows: [] }
      if (sql === SQL.legacy) {
        legacyReads++
        const n = transactions.filter(t => t.platform === null && t.agente.toLowerCase() === params[0].toLowerCase()
          && t.fecha >= params[1] && t.fecha <= params[2]).length
        return { rows: [{ n: String(n + (legacyReads > 1 && secondLegacyConflict ? 1 : 0)) }] }
      }
      if (sql === SQL.legacyIds) return { rows: [{ n: String(transactions.filter(t => t.platform === null && params[0].includes(t.id_rec)).length) }] }
      if (sql === SQL.names) return { rows: params[0].map(username => ({ username,
        uname: caseMismatch ? 'different-db-case' : username.toLowerCase(), lower_agent: params[1].toLowerCase() })) }
      if (sql === SQL.history) return { rows: historyOverride || transactions.filter(t => params[0].includes(t.uname)) }
      if (sql === SQL.conflicts) return { rows: transactions.filter(t => t.platform === params[0] && params[1].includes(t.id_rec)) }
      if (sql === SQL.players) return { rows: players.filter(p => params[0].includes(p.username_lower)) }
      if (sql === SQL.cursor) return { rows: cursor ? [cursor] : [] }
      throw Error('UNEXPECTED SQL: mock refuses anything not explicitly allowed')
    }),
  }
  const pool = { connect: jest.fn(async () => client) }
  const createConnector = jest.fn(() => connector)
  const run = opts => runPreview(opts || SCOPE, { pool, createConnector, now: () => NOW,
    env: { CASINO_SYNC_PAUSED: '1' } })
  return { connector, client, pool, createConnector, run }
}
function prepared(rows) { return new FixtureConnector(rows).prepareTransactions(rows) }
const project = (raw, rows, players = [], conflicts = []) => projectImpact({
  prepared: prepared(raw), history: rows, players, conflicts, platform: 'zeus', agente: 'betcoin', lowerAgent: 'betcoin',
})

// These tests use in-memory rows and a rejecting client, never a DB or provider.
describe('preview scope validation', () => {
  it('requires explicit single-agent/single-closed-day scope', () => {
    expect(parse(CLI)).toMatchObject({ ok: true, value: SCOPE })
    expect(parseSyncArgs(CLI, { now: new Date('2026-09-15T01:00:00Z') }).ok).toBe(false) // still Sep 14 ART
  })
  it.each([
    CLI.filter(x => !x.startsWith('--platform=')), CLI.filter(x => !x.startsWith('--agentes=')),
    CLI.filter(x => !x.startsWith('--desde=')), CLI.filter(x => !x.startsWith('--hasta=')),
    CLI.map(x => x === '--preview' ? '--preview=false' : x),
    CLI.map(x => x.startsWith('--platform=') ? '--platform=ganamos' : x),
    CLI.map(x => x.startsWith('--agentes=') ? '--agentes=betcoin,royal' : x),
    CLI.map(x => x.startsWith('--agentes=') ? '--agentes=betcoin,betcoin' : x),
    CLI.map(x => x.startsWith('--desde=') ? '--desde=2026-09-13' : x),
    [...CLI, '--auto'], [...CLI, '--chunk-days=1'], [...CLI, '--concurrency=1'],
    [...CLI, '--run-id=11111111-1111-4111-8111-111111111111'],
    [...CLI, '--trigger=api'], [...CLI, '--preview'], [...CLI, 'private argument'],
  ].map(args => [args]))('rejects unsafe/ambiguous preview args without echoing values: %p', args => {
    const result = parse(args)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('private argument')
  })
  it('does not add a preview flag or change existing write defaults', () => {
    expect(parseSyncArgs([], { now: NOW }).value).toMatchObject({ platform: 'zeus', mode: 'range', desde: '2020-01-01', hasta: '2026-09-15' })
    expect(parseSyncArgs([], { now: NOW }).value).not.toHaveProperty('preview')
  })
  it.each([
    { ...SCOPE, desde: undefined }, { ...SCOPE, platform: undefined }, { ...SCOPE, agentes: ['a', 'b'] },
    { ...SCOPE, desde: '2026-09-15', hasta: '2026-09-15' }, { ...SCOPE, preview: false },
  ])('the callable entry point also rejects before connection or authentication', async scope => {
    const f = fixture()
    expect(await f.run(scope)).toMatchObject({ status: 'blocked', error_code: 'PREVIEW_SCOPE_INVALID', exitCode: 2, impact: null })
    expect(f.pool.connect).not.toHaveBeenCalled()
    expect(f.createConnector).not.toHaveBeenCalled()
  })
})

describe('read-only preview orchestration', () => {
  it('separates inflation correction from new deposits; never invokes write methods or returns identities', async () => {
    const f = fixture({ transactions: [stored()], players: [player()] })
    const result = await f.run()
    expect(result).toMatchObject({ status: 'complete', exitCode: 0, read_only: true, write_authorized: false,
      impact: { transactions: { inserted: 1, timestamp_updated: 0 },
        aggregates: { A_current: { total_cargas: '1000' }, B_existing_source: { total_cargas: '100' }, C_projected: { total_cargas: '150' } },
        deltas: { historical_recompute: { total_cargas: '-900' }, new_batch: { total_cargas: '50' }, effective: { total_cargas: '-850' } },
        players: { recomputed: 1, aggregates_decreased: 1, last_date_changed: 1 } },
      cursor_projection: { moved: true, reason: 'established', cursor: { coveredFrom: DAY, coveredThrough: DAY } } })
    expect(JSON.stringify(result)).not.toMatch(/PrivatePlayer|privateplayer|private provider details/)
    expect(f.createConnector).toHaveBeenCalledWith('zeus', null)
    for (const method of ['syncAgent', 'persistSync', 'writeTransactions', 'recomputePlayers']) expect(f.connector[method]).not.toHaveBeenCalled()
    expect(f.client.query.mock.calls.every(([sql]) => /^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SHOW |SET LOCAL |SELECT |ROLLBACK)/.test(sql))).toBe(true)
    expect(f.client.query.mock.calls.some(([sql]) => /\b(INSERT|UPDATE|DELETE|COMMIT|nextval|advisory|FOR UPDATE)\b/i.test(sql))).toBe(false)
    expect(f.client.release).toHaveBeenCalledTimes(1)
  })
  it.each([{ readOnly: false, code: 'READ_ONLY_NOT_ENFORCED' }, { isolation: false, code: 'SNAPSHOT_NOT_ENFORCED' }])('checks DB guarantees before provider access', async ({ code, ...options }) => {
    const f = fixture(options)
    expect(await f.run()).toMatchObject({ status: 'blocked', error_code: code, impact: null })
    expect(f.createConnector).not.toHaveBeenCalled()
    expect(f.client.query).toHaveBeenCalledWith('ROLLBACK')
  })
  it('stops on same-agent legacy dates before authentication, using parameterized SQL', async () => {
    const f = fixture({ transactions: [stored({ fecha: DAY })] })
    expect(await f.run()).toMatchObject({ status: 'blocked', error_code: 'LEGACY_RANGE_UNCLASSIFIED' })
    expect(f.createConnector).not.toHaveBeenCalled()
    expect(f.client.query).toHaveBeenCalledWith(SQL.legacy, ['betcoin', DAY, DAY])
    expect(SQL.legacy).not.toContain('betcoin')
  })
  it('detects global legacy ID collision even from another agent and year', async () => {
    const f = fixture({ transactions: [stored({ id_rec: '100', agente: 'bigwin', fecha: '2023-01-01' })] })
    expect(await f.run()).toMatchObject({ status: 'blocked', error_code: 'LEGACY_ID_UNCLASSIFIED', impact: null })
    expect(f.connector.fetchTransactions).toHaveBeenCalledTimes(1)
    expect(f.client.query).toHaveBeenCalledWith(SQL.legacyIds, [['100']])
  })
  it('rechecks legacy after provider fetch against a fresh read-only snapshot', async () => {
    const f = fixture({ secondLegacyConflict: true })
    expect(await f.run()).toMatchObject({ status: 'blocked', error_code: 'LEGACY_RANGE_UNCLASSIFIED' })
    expect(f.connector.fetchTransactions).toHaveBeenCalledTimes(1)
  })
  it('accepts an empty valid response and projects only the cursor, with no source sample', async () => {
    const f = fixture({ raw: [] })
    expect(await f.run()).toMatchObject({ status: 'complete', impact: { transactions: { inserted: 0 }, players: { recomputed: 0 } },
      cursor_projection: { moved: true } })
  })
  it.each([
    [{ raw: {} }, 'INVALID_PROVIDER_RESPONSE'],
    [{ raw: [provider({ id_rec: 0 })] }, 'UNIDENTIFIED_TRANSACTIONS'],
    [{ raw: [provider({ monto: Number.MAX_SAFE_INTEGER + 1 })] }, 'UNSAFE_PROVIDER_AMOUNT'],
    [{ raw: [provider({ fecha: '2026-09-13' })] }, 'PROVIDER_RANGE_MISMATCH'],
    [{ raw: [provider()], normalization: { rows: [], invalid: 1, excluded: 0 } }, 'INVALID_TRANSACTIONS'],
    [{ raw: [provider(), provider({ username: 'DifferentPlayer' })] }, 'DUPLICATE_ID_CONTENT_CONFLICT'],
    [{ caseMismatch: true }, 'CASE_MAPPING_INDETERMINATE'],
    [{ raw: Array(LIMITS.fetched + 1).fill(provider()) }, 'FETCH_LIMIT_EXCEEDED'],
    [{ raw: Array.from({ length: LIMITS.players + 1 }, (_, i) => provider({ id_rec: String(i + 1), username: 'user' + i })) }, 'PLAYER_LIMIT_EXCEEDED'],
    [{ historyOverride: Array(LIMITS.history + 1).fill(stored()) }, 'HISTORY_LIMIT_EXCEEDED'],
  ])('does not invent exact impacts for unsupported or truncated input', async (options, code) => {
    expect(await fixture(options).run()).toMatchObject({ status: 'blocked', error_code: code, impact: null, write_authorized: false })
  })
  it.each([
    new Error('secret provider URL https://fixture.invalid/?token=private-secret'),
    new SyncError('INVALID_RESPONSE', 'private-secret provider body'),
    Object.assign(new Error('private-secret'), { code: '23505' }),
  ])('never echoes external exception text, including domain messages', async error => {
    const f = fixture()
    f.connector.fetchTransactions.mockRejectedValue(error)
    const result = await f.run()
    expect(result.status).toBe('failed')
    expect(JSON.stringify(result)).not.toMatch(/private-secret|fixture.invalid|provider body/)
  })
  it('discards a broken read-only client and reports no usable impact', async () => {
    const f = fixture({ rollbackFails: true })
    expect(await f.run()).toMatchObject({ status: 'failed', error_code: 'READ_ONLY_CLEANUP_FAILED', impact: null })
    expect(f.client.release.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(f.createConnector).not.toHaveBeenCalled()
  })
  it('reflects an existing disjoint cursor without advancing over the gap', async () => {
    const f = fixture({ cursor: { covered_from: '2026-08-01', covered_through: '2026-08-10' } })
    expect(await f.run()).toMatchObject({ cursor_projection: { moved: false, reason: 'disjoint',
      cursor: { coveredFrom: '2026-08-01', coveredThrough: '2026-08-10' } } })
  })
  it('retains the existing frontend SSL interpretation for a synthetic connection', () => {
    const c = previewPoolOptions({ DATABASE_URL: 'postgresql://synthetic:fake@localhost/test?sslmode=require', DB_SSL_REJECT_UNAUTHORIZED: ' true\n' })
    expect(c.ssl).toEqual({ rejectUnauthorized: true })
    expect(c.connectionString).toContain('uselibpqcompat=true')
    expect(c.options).toBe('-c default_transaction_read_only=on')
    expect(previewPoolOptions({ DATABASE_URL: 'postgresql://synthetic:fake@localhost/test', DB_SSL: ' false\n' }).ssl).toBe(false)
  })
})

describe('A/B/C projection semantics (integer source values, no DB)', () => {
  it('keeps other agents/platforms and legacy, excludes agent transfers, and assigns current metadata', () => {
    const rows = [stored({ monto: '4000', agente: 'old' }),
      stored({ id: '2', platform: 'bet30', agente: 'btcuno', tipo: 'retiro', monto: '100' }),
      stored({ id: '3', agente: 'PRIVATEPLAYER', monto: '999999' })]
    const r = project([provider({ monto: 600 })], rows, [player({ agente: 'btcuno', platform: 'bet30' })])
    expect(r.aggregates.C_projected).toEqual({ total_cargas: '4600', total_retiros: '100', cant_cargas: '2', cant_retiros: '1' })
    expect(r.players).toMatchObject({ agent_changed: 1, platform_changed: 1 })
  })
  it('predicts idempotence and missing timestamp enrichment without inserting a duplicate', () => {
    const row = stored({ id_rec: '100', platform: 'zeus', fecha: DAY, monto: '50' })
    const r = project([provider()], [row], [player({ total_cargas: '50', cant_cargas: '1', fecha_ultima: DAY })], [row])
    expect(r.transactions).toEqual({ inserted: 0, timestamp_updated: 1, unchanged: 0, provider_revisions_not_applied: 0 })
    expect(r.deltas.new_batch.total_cargas).toBe('0')
    expect(r.deltas.effective.total_cargas).toBe('0')
  })
  it('does not pretend existing transaction amounts are replaced by provider revisions', () => {
    const row = stored({ id_rec: '100', platform: 'zeus', monto: '80', fecha: DAY })
    const r = project([provider({ monto: 150 })], [row], [player()], [row])
    expect(r.transactions).toMatchObject({ inserted: 0, provider_revisions_not_applied: 1 })
    expect(r.aggregates.C_projected.total_cargas).toBe('80')
  })
  it('uses exact BigInt arithmetic beyond the JavaScript safe-integer limit', () => {
    const r = project([provider({ monto: 1 })], [stored({ monto: '9007199254740993' })],
      [player({ total_cargas: '9007199254740993', cant_cargas: '1' })])
    expect(r.aggregates.C_projected.total_cargas).toBe('9007199254740994')
    expect(r.deltas.effective.total_cargas).toBe('1')
  })
  it('reports reset of prior totals with no transaction source once a new movement makes the target recomputable', () => {
    const r = project([provider()], [], [player({ total_cargas: '100', cant_cargas: '1' })])
    expect(r.aggregates.B_existing_source.total_cargas).toBe('0')
    expect(r.deltas.historical_recompute.total_cargas).toBe('-100')
    expect(r.deltas.effective.total_cargas).toBe('-50')
  })
  it('never includes untouched players in impact or invents a player for an excluded source', () => {
    const r = project([provider({ username: 'betcoin' })], [], [player()])
    expect(r.transactions.inserted).toBe(1)
    expect(r.players).toMatchObject({ recomputed: 0, unchanged_targets: 1 })
    expect(r.aggregates.C_projected.total_cargas).toBe('0')
  })
  it('preserves metadata when latest transaction platform is NULL (COALESCE on existing players)', () => {
    const recentLegacy = stored({ id: '8', fecha: '2026-09-15', agente: 'old', platform: null })
    const r = project([provider()], [recentLegacy], [player({ agente: 'old', platform: 'bet30' })])
    expect(r.players).toMatchObject({ agent_changed: 0, platform_changed: 0 })
  })
  it('uses microseconds and then existing row IDs for metadata ordering', () => {
    const rows = [stored({ id: '2', fecha: DAY, fecha_hora_utc: `${DAY}T15:00:00.000002Z`, agente: 'btcuno', platform: 'bet30' }),
      stored({ id: '3', fecha: DAY, fecha_hora_utc: `${DAY}T15:00:00.000002Z`, agente: 'royal', platform: 'zeus' })]
    const r = project([provider()], rows, [player({ agente: 'royal', platform: 'zeus' })])
    expect(r.players.agent_changed).toBe(0)
  })
  it('blocks ambiguous metadata involving an unallocated INSERT ID rather than guessing', () => {
    const row = stored({ fecha: DAY, fecha_hora_utc: `${DAY}T15:00:00.000000Z`, agente: 'btcuno', platform: 'bet30' })
    expect(() => project([provider()], [row], [player()])).toThrow('METADATA_TIE_INDETERMINATE')
  })
  it.each([
    [[stored({ monto: '9223372036854775807' })], [player()], 'PROJECTED_AGGREGATE_OVERFLOW'],
    [[stored()], [player({ total_cargas: null })], 'INVALID_INTEGER'],
  ])('blocks unsupported aggregate results or NULL baselines', (rows, players, code) => {
    expect(() => project([provider()], rows, players)).toThrow(code)
  })
})
