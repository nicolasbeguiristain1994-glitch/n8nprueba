'use strict'

const {
  BaseCasinoConnector,
  normalizeIdRec,
  PLAYER_LOCK_NAMESPACE,
} = require('../../src/casino-connectors/base/BaseCasinoConnector')

// ── Minimal concrete subclass ─────────────────────────────────────────────────
// BaseCasinoConnector is abstract; we need a real subclass to exercise its
// inherited methods without coupling the test to any specific platform.

class TestConnector extends BaseCasinoConnector {
  constructor(config, pool, raw = []) {
    super(config, pool)
    this.raw = raw
  }
  async fetchTransactions()         { return this.raw }
  async normalizeTransactions(raw)  { return raw }
  async healthCheck()               { return true }
}

// ── Factories ─────────────────────────────────────────────────────────────────

const BASE_CONFIG = {
  name:     'test',
  type:     'test',
  baseUrl:  'https://test.internal',
  endpoint: '/api/test',
}

/**
 * Cliente pg simulado. Los INSERT en casino_transactions devuelven una fila
 * `{inserted}` por cada fila enviada (como RETURNING (xmax = 0)).
 */
function makeClient({ failOn = null, insertedFlags = null } = {}) {
  const query = jest.fn(async (sql, params = []) => {
    if (failOn && failOn(sql)) throw Object.assign(new Error('db error'), { code: '40001' })
    if (/INSERT INTO casino_transactions/.test(sql)) {
      const width = /\(platform, id_rec,/.test(sql) ? 9 : 8
      const n     = params.length / width
      const rows  = Array.from({ length: n }, (_, i) => ({ inserted: insertedFlags ? insertedFlags[i] : true }))
      return { rows, rowCount: n }
    }
    if (/INSERT INTO casino_players/.test(sql)) return { rows: [], rowCount: params[0].length }
    return { rows: [], rowCount: 0 }
  })
  return { query, release: jest.fn() }
}

function makeConnector(clientOpts = {}, raw = []) {
  const client = makeClient(clientOpts)
  const pool   = {
    connect: jest.fn().mockResolvedValue(client),
    query:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  }
  return { connector: new TestConnector(BASE_CONFIG, pool, raw), pool, client }
}

function tx(overrides = {}) {
  return {
    id_rec:         '101',
    fecha:          '2025-01-01',
    fecha_hora_utc: '2025-01-01T15:00:00.000Z',
    username:       'player1',
    agente:         'agente1',
    tipo:           'carga',
    monto:          100,
    raw_detalles:   'Carga directa',
    ...overrides,
  }
}

function sqlCalls(client) {
  return client.query.mock.calls.map(c => c[0].replace(/\s+/g, ' ').trim())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BaseCasinoConnector', () => {

  // Skip setTimeout delays so retry tests run instantly
  beforeEach(() => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0 })
  })
  afterEach(() => jest.restoreAllMocks())

  // ── Abstract guard ──────────────────────────────────────────────────────────

  describe('abstract instantiation guard', () => {
    it('throws when trying to instantiate the base class directly', () => {
      const { pool } = makeConnector()
      expect(() => new BaseCasinoConnector(BASE_CONFIG, pool))
        .toThrow('BaseCasinoConnector is abstract')
    })

    it('allows instantiation of a concrete subclass', () => {
      const { pool } = makeConnector()
      expect(() => new TestConnector(BASE_CONFIG, pool)).not.toThrow()
    })

    it('exposes the platform from config.name', () => {
      const { connector } = makeConnector()
      expect(connector.platform).toBe('test')
    })
  })

  // ── _validateConfig ─────────────────────────────────────────────────────────

  describe('_validateConfig()', () => {
    it.each(['name', 'type', 'baseUrl', 'endpoint'])(
      'throws when required field "%s" is missing',
      (field) => {
        const { pool } = makeConnector()
        const config = { ...BASE_CONFIG, [field]: undefined }
        expect(() => new TestConnector(config, pool))
          .toThrow(`missing required field: "${field}"`)
      }
    )
  })

  // ── _validateEnvVars ────────────────────────────────────────────────────────

  describe('_validateEnvVars()', () => {
    it('throws listing every missing variable in one error', () => {
      const { connector } = makeConnector()
      delete process.env.MISSING_A
      delete process.env.MISSING_B
      expect(() => connector._validateEnvVars(['MISSING_A', 'MISSING_B']))
        .toThrow('Missing required environment variable(s) for platform "test": MISSING_A, MISSING_B')
    })

    it('only lists the actually missing variables', () => {
      const { connector } = makeConnector()
      process.env.PRESENT_VAR  = 'value'
      delete process.env.ABSENT_VAR
      expect(() => connector._validateEnvVars(['PRESENT_VAR', 'ABSENT_VAR']))
        .toThrow('ABSENT_VAR')
      delete process.env.PRESENT_VAR
    })

    it('does not throw when all variables are set', () => {
      const { connector } = makeConnector()
      process.env.MY_VAR = 'ok'
      expect(() => connector._validateEnvVars(['MY_VAR'])).not.toThrow()
      delete process.env.MY_VAR
    })

    it('treats whitespace-only values as missing', () => {
      const { connector } = makeConnector()
      process.env.BLANK_VAR = '   '
      expect(() => connector._validateEnvVars(['BLANK_VAR'])).toThrow('BLANK_VAR')
      delete process.env.BLANK_VAR
    })
  })

  // ── _fetchWithRetry ─────────────────────────────────────────────────────────

  describe('_fetchWithRetry()', () => {
    let connector

    beforeEach(() => ({ connector } = makeConnector()))

    it('returns the response on first success', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 })
      const res = await connector._fetchWithRetry('http://test', {}, 'ctx')
      expect(res.status).toBe(200)
      expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    it('retries on 5xx and succeeds on the 3rd attempt', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValue(  { ok: true,  status: 200 })
      const res = await connector._fetchWithRetry('http://test', {}, 'ctx')
      expect(global.fetch).toHaveBeenCalledTimes(3)
      expect(res.status).toBe(200)
    })

    it('retries on network errors (fetch throws)', async () => {
      global.fetch = jest.fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue(  { ok: true, status: 200 })
      const res = await connector._fetchWithRetry('http://test', {}, 'ctx')
      expect(global.fetch).toHaveBeenCalledTimes(3)
      expect(res.status).toBe(200)
    })

    it('does NOT retry on 4xx — fails immediately', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 })
      await expect(connector._fetchWithRetry('http://test', {}, 'ctx'))
        .rejects.toThrow('HTTP 401')
      expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    it('does NOT retry on 403', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 })
      await expect(connector._fetchWithRetry('http://test', {}, 'ctx'))
        .rejects.toThrow('HTTP 403')
      expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    it('throws after exhausting all 4 attempts', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 })
      await expect(connector._fetchWithRetry('http://test', {}, 'ctx'))
        .rejects.toThrow('All 4 attempts failed')
      expect(global.fetch).toHaveBeenCalledTimes(4)
    })

    it('logs a console.warn for each retry (not for the final failure)', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValue(  { ok: true,  status: 200 })
      await connector._fetchWithRetry('http://test', {}, 'agent "x"')
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn.mock.calls[0][0]).toMatch(/Retry 1\/3/)
      expect(warn.mock.calls[1][0]).toMatch(/Retry 2\/3/)
    })

    it('never propagates nor logs the text of a network error (may carry URL/credentials)', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      global.fetch = jest.fn().mockRejectedValue(Object.assign(
        new TypeError('fetch failed https://user:synthetic phrase with spaces@host.invalid/x?token=zzz9'),
        { cause: { code: 'ECONNRESET' } },
      ))
      const err = await connector._fetchWithRetry('http://test', {}, 'agent "x"').catch(e => e)

      expect(err.message).toBe('[test] All 4 attempts failed for agent "x": error de red (ECONNRESET)')
      expect(JSON.stringify([err.message, warn.mock.calls])).not.toMatch(/synthetic|zzz9|host\.invalid/)
    })

    it('keeps the last HTTP status as a property after exhausting retries', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 })
      const err = await connector._fetchWithRetry('http://test', {}, 'ctx').catch(e => e)
      expect(err.httpStatus).toBe(502)
    })

    it('includes the context label in every retry log', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValue(  { ok: true,  status: 200 })
      await connector._fetchWithRetry('http://test', {}, 'agent "betcoin"')
      expect(warn.mock.calls[0][0]).toContain('agent "betcoin"')
    })
  })

  // ── normalizeIdRec ──────────────────────────────────────────────────────────

  describe('normalizeIdRec()', () => {
    it.each([
      [null, null], [undefined, null], ['', null], ['   ', null],
      [0, null], ['0', null], ['000', null],
      [-1, null], ['-1', null], [1.5, null], ['1.5', null], ['abc', null], ['r1', null],
      ['9223372036854775808', null],
    ])('treats %p as "sin ID"', (input, expected) => {
      expect(normalizeIdRec(input)).toBe(expected)
    })

    it.each([
      [42, '42'], ['42', '42'], [' 42 ', '42'], ['0042', '42'],
      ['9223372036854775807', '9223372036854775807'], [BigInt(7), '7'],
    ])('keeps valid id %p as %p', (input, expected) => {
      expect(normalizeIdRec(input)).toBe(expected)
    })
  })

  // ── prepareTransactions ─────────────────────────────────────────────────────

  describe('prepareTransactions()', () => {
    let connector
    beforeEach(() => ({ connector } = makeConnector()))

    it('dedupes repeated IDs inside the batch and counts them', () => {
      const p = connector.prepareTransactions([tx({ id_rec: '1' }), tx({ id_rec: '1' }), tx({ id_rec: '2' })])
      expect(p.withId).toHaveLength(2)
      expect(p.stats.duplicateIds).toBe(1)
      expect(p.coverage).toBe('complete')
    })

    it('routes id_rec = 0 to the no-ID path and marks coverage as limited', () => {
      const p = connector.prepareTransactions([tx({ id_rec: 0 })])
      expect(p.withId).toHaveLength(0)
      expect(p.withoutId).toHaveLength(1)
      expect(p.stats.withoutId).toBe(1)
      expect(p.coverage).toBe('limited')
    })

    it('counts no-ID movements that the per-day key cannot tell apart', () => {
      const p = connector.prepareTransactions([
        tx({ id_rec: null, username: 'Juan' }),
        tx({ id_rec: null, username: 'juan' }),   // mismo día, tipo y monto
        tx({ id_rec: null, username: 'juan', monto: 200 }),
      ])
      expect(p.withoutId).toHaveLength(2)
      expect(p.stats.collapsedWithoutId).toBe(1)
    })

    it('trims usernames, lowercases the recompute list and skips invalid rows', () => {
      const p = connector.prepareTransactions([
        tx({ id_rec: '1', username: '  Juan22 ' }),
        tx({ id_rec: '2', username: 'JUAN22' }),
        tx({ id_rec: '3', username: '   ' }),
        tx({ id_rec: '4', tipo: 'bono' }),
      ])
      expect(p.withId.map(r => r.username)).toEqual(['Juan22', 'JUAN22'])
      expect(p.usernames).toEqual(['juan22'])
      expect(p.stats.invalid).toBe(2)
    })
  })

  // ── persistSync ─────────────────────────────────────────────────────────────

  describe('persistSync()', () => {
    it('does not open a connection for an empty batch without hooks', async () => {
      const { connector, pool } = makeConnector()
      const res = await connector.persistSync('ag', connector.prepareTransactions([]))
      expect(res).toEqual({ inserted: 0, updated: 0, players: 0 })
      expect(pool.connect).not.toHaveBeenCalled()
    })

    it('still runs a transaction for an empty batch when afterWrite must record it', async () => {
      const { connector, client } = makeConnector()
      const afterWrite = jest.fn()
      await connector.persistSync('ag', connector.prepareTransactions([]), { afterWrite })
      expect(afterWrite).toHaveBeenCalledWith(client, { inserted: 0, updated: 0, players: 0 })
      const ops = sqlCalls(client)
      expect(ops[0]).toBe('BEGIN')
      expect(ops[ops.length - 1]).toBe('COMMIT')
    })

    it('inserts, locks players, recomputes and records in ONE transaction, in that order', async () => {
      const { connector, client } = makeConnector()
      const afterWrite = jest.fn(async (c) => { await c.query('SELECT hook') })
      await connector.persistSync('ag', connector.prepareTransactions([tx()]), { afterWrite })

      const ops = sqlCalls(client)
      const idx = re => ops.findIndex(s => re.test(s))
      expect(ops[0]).toBe('BEGIN')
      expect(idx(/INSERT INTO casino_transactions/)).toBeGreaterThan(0)
      expect(idx(/pg_advisory_xact_lock/)).toBeGreaterThan(idx(/INSERT INTO casino_transactions/))
      expect(idx(/INSERT INTO casino_players/)).toBeGreaterThan(idx(/pg_advisory_xact_lock/))
      expect(idx(/SELECT hook/)).toBeGreaterThan(idx(/INSERT INTO casino_players/))
      expect(ops[ops.length - 1]).toBe('COMMIT')
      expect(client.release).toHaveBeenCalledTimes(1)
    })

    it('tags every row with the connector platform and dedupes by (platform, id_rec)', async () => {
      const { connector, client } = makeConnector()
      await connector.persistSync('ag', connector.prepareTransactions([tx({ id_rec: '5' })]))
      const [sql, params] = client.query.mock.calls.find(c => /INSERT INTO casino_transactions/.test(c[0]))
      expect(sql).toContain('ON CONFLICT (platform, id_rec)')
      expect(params[0]).toBe('test')
      expect(params[1]).toBe('5')
    })

    it('routes rows without ID to the per-platform, case-insensitive day key', async () => {
      const { connector, client } = makeConnector()
      await connector.persistSync('ag', connector.prepareTransactions([tx({ id_rec: null })]))
      const [sql, params] = client.query.mock.calls.find(c => /INSERT INTO casino_transactions/.test(c[0]))
      expect(sql).toMatch(/ON CONFLICT \(platform, fecha, \(LOWER\(username\)\), tipo, monto, agente\)/)
      expect(params[0]).toBe('test')
    })

    it('counts only real inserts as inserted (RETURNING xmax = 0)', async () => {
      const { connector } = makeConnector({ insertedFlags: [true, false, true] })
      const res = await connector.persistSync('ag', connector.prepareTransactions([
        tx({ id_rec: '1' }), tx({ id_rec: '2' }), tx({ id_rec: '3' }),
      ]))
      expect(res.inserted).toBe(2)
      expect(res.updated).toBe(1)
    })

    it('recomputes by ASSIGNING totals from casino_transactions, never adding EXCLUDED', async () => {
      const { connector, client } = makeConnector()
      await connector.persistSync('ag', connector.prepareTransactions([tx()]))
      const sql = sqlCalls(client).find(s => /INSERT INTO casino_players/.test(s))
      expect(sql).toMatch(/FROM casino_transactions ct/)
      expect(sql).toMatch(/total_cargas = EXCLUDED\.total_cargas/)
      expect(sql).toMatch(/cant_retiros = EXCLUDED\.cant_retiros/)
      expect(sql).not.toMatch(/casino_players\.total_cargas\s*\+/)
      expect(sql).not.toMatch(/seg_monto|seg_actividad|labels/)
      expect(sql).toMatch(/LOWER\(ct\.username\) <> LOWER\(ct\.agente\)/)
    })

    it('takes per-player advisory locks in key order before recomputing', async () => {
      const { connector, client } = makeConnector()
      await connector.persistSync('ag', connector.prepareTransactions([
        tx({ id_rec: '1', username: 'Zeta' }), tx({ id_rec: '2', username: 'alfa' }),
      ]))
      const [sql, params] = client.query.mock.calls.find(c => /pg_advisory_xact_lock/.test(c[0]))
      expect(sql).toMatch(/ORDER BY k/)
      expect(params[0]).toBe(PLAYER_LOCK_NAMESPACE)
      expect(params[1].sort()).toEqual(['alfa', 'zeta'])
    })

    it('rolls back everything (no COMMIT, no hook) when the recompute fails', async () => {
      const { connector, client } = makeConnector({ failOn: sql => /INSERT INTO casino_players/.test(sql) })
      const afterWrite = jest.fn()
      await expect(connector.persistSync('ag', connector.prepareTransactions([tx()]), { afterWrite }))
        .rejects.toThrow('db error')
      const ops = sqlCalls(client)
      expect(ops).toContain('ROLLBACK')
      expect(ops).not.toContain('COMMIT')
      expect(afterWrite).not.toHaveBeenCalled()
      expect(client.release).toHaveBeenCalledTimes(1)
    })

    it('rolls back when afterWrite fails (cursor/result are atomic with the data)', async () => {
      const { connector, client } = makeConnector()
      const afterWrite = jest.fn().mockRejectedValue(new Error('cursor write failed'))
      await expect(connector.persistSync('ag', connector.prepareTransactions([tx()]), { afterWrite }))
        .rejects.toThrow('cursor write failed')
      expect(sqlCalls(client)).toContain('ROLLBACK')
      expect(sqlCalls(client)).not.toContain('COMMIT')
    })

    it('aborts before writing when beforeWrite throws', async () => {
      const { connector, client } = makeConnector()
      const beforeWrite = jest.fn().mockRejectedValue(new Error('legacy rows'))
      await expect(connector.persistSync('ag', connector.prepareTransactions([tx()]), { beforeWrite }))
        .rejects.toThrow('legacy rows')
      expect(sqlCalls(client).some(s => /INSERT/.test(s))).toBe(false)
      expect(sqlCalls(client)).toContain('ROLLBACK')
    })

    it('fails closed (LEGACY_UNCLASSIFIED) when an ID collides with an unclassified legacy row', async () => {
      const { connector, client } = makeConnector()
      const base = client.query.getMockImplementation()
      client.query.mockImplementation(async (sql, params) =>
        /platform IS NULL AND id_rec = ANY/.test(sql) ? { rows: [{ n: 1 }], rowCount: 1 } : base(sql, params))

      await expect(connector.persistSync('ag', connector.prepareTransactions([tx()])))
        .rejects.toMatchObject({ code: 'LEGACY_UNCLASSIFIED' })
      expect(sqlCalls(client).some(s => /INSERT/.test(s))).toBe(false)
      expect(sqlCalls(client)).toContain('ROLLBACK')
    })

    it('discards the connection when ROLLBACK itself fails', async () => {
      const { connector, client } = makeConnector({
        failOn: sql => /INSERT INTO casino_players/.test(sql) || sql === 'ROLLBACK',
      })
      await expect(connector.persistSync('ag', connector.prepareTransactions([tx()]))).rejects.toThrow()
      expect(client.release).toHaveBeenCalledWith(expect.any(Error))
    })

    it('batches large inputs (500 rows per INSERT)', async () => {
      const { connector, client } = makeConnector()
      const rows = Array.from({ length: 1001 }, (_, i) => tx({ id_rec: String(i + 1) }))
      const res  = await connector.persistSync('ag', connector.prepareTransactions(rows))
      const inserts = client.query.mock.calls.filter(c => /INSERT INTO casino_transactions/.test(c[0]))
      expect(inserts).toHaveLength(3)
      expect(res.inserted).toBe(1001)
    })
  })

  // ── syncAgent ───────────────────────────────────────────────────────────────

  describe('syncAgent()', () => {
    it('returns honest counters and passes them to afterWrite', async () => {
      const raw = [tx({ id_rec: '1' }), tx({ id_rec: '1' }), tx({ id_rec: null, username: 'p2' })]
      const { connector } = makeConnector({}, raw)
      const afterWrite = jest.fn()
      const summary = await connector.syncAgent('ag', '2025-01-01', '2025-01-01', { afterWrite })

      expect(summary).toMatchObject({
        txCount:         3,
        txNormalized:    3,
        insertedTxCount: 2,
        txWithoutId:     1,
        txDuplicateIds:  1,
        coverage:        'limited',
      })
      expect(summary.fetchStartedAt).toBeInstanceOf(Date)
      expect(afterWrite.mock.calls[0][1]).toMatchObject({ insertedTxCount: 2, coverage: 'limited' })
    })

    it('rows the connector could not interpret make coverage limited (never "complete")', async () => {
      const { connector } = makeConnector({}, [tx({ id_rec: '1' }), tx({ id_rec: '2' })])
      connector.normalizeWithStats = async raw => ({ rows: raw.slice(0, 1), invalid: 1, excluded: 0 })
      const summary = await connector.syncAgent('ag', '2025-01-01', '2025-01-01')
      expect(summary).toMatchObject({ txInvalid: 1, coverage: 'limited' })
    })

    it('by default, rows dropped by normalizeTransactions count as invalid', async () => {
      const { connector } = makeConnector({}, [tx({ id_rec: '1' }), tx({ id_rec: '2' })])
      connector.normalizeTransactions = async raw => raw.slice(0, 1)
      const summary = await connector.syncAgent('ag', '2025-01-01', '2025-01-01')
      expect(summary).toMatchObject({ txInvalid: 1, coverage: 'limited' })
    })

    it('expected exclusions do not limit coverage', async () => {
      const { connector } = makeConnector({}, [tx({ id_rec: '1' }), tx({ id_rec: '2' })])
      connector.normalizeWithStats = async raw => ({ rows: raw.slice(0, 1), invalid: 0, excluded: 1 })
      const summary = await connector.syncAgent('ag', '2025-01-01', '2025-01-01')
      expect(summary).toMatchObject({ txInvalid: 0, txExcluded: 1, coverage: 'complete' })
    })

    it('propagates fetch errors without touching the database', async () => {
      const { connector, pool } = makeConnector()
      connector.fetchTransactions = jest.fn().mockRejectedValue(new Error('HTTP 503'))
      await expect(connector.syncAgent('ag', '2025-01-01', '2025-01-01')).rejects.toThrow('HTTP 503')
      expect(pool.connect).not.toHaveBeenCalled()
    })
  })
})
