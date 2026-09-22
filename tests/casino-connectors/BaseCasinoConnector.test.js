'use strict'

const { BaseCasinoConnector } = require('../../src/casino-connectors/base/BaseCasinoConnector')

// ── Minimal concrete subclass ─────────────────────────────────────────────────
// BaseCasinoConnector is abstract; we need a real subclass to exercise its
// inherited methods without coupling the test to any specific platform.

class TestConnector extends BaseCasinoConnector {
  async fetchTransactions()         { return [] }
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

function makeClient(overrides = {}) {
  return {
    query:   jest.fn().mockResolvedValue({ rowCount: 1 }),
    release: jest.fn(),
    ...overrides,
  }
}

function makePool(clientOverrides = {}) {
  const client = makeClient(clientOverrides)
  const pool   = {
    connect: jest.fn().mockResolvedValue(client),
    query:   jest.fn().mockResolvedValue({ rowCount: 1 }),
  }
  return { pool, client }
}

function makeConnector(poolOverrides = {}) {
  const { pool, client } = makePool(poolOverrides)
  return { connector: new TestConnector(BASE_CONFIG, pool), pool, client }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function txWith(overrides = {}) {
  return {
    id_rec:         'r1',
    fecha:          '2025-01-01',
    fecha_hora_utc: null,
    username:       'player1',
    agente:         'agente1',
    tipo:           'carga',
    monto:          100,
    raw_detalles:   'Carga directa',
    ...overrides,
  }
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
      const { pool } = makePool()
      expect(() => new BaseCasinoConnector(BASE_CONFIG, pool))
        .toThrow('BaseCasinoConnector is abstract')
    })

    it('allows instantiation of a concrete subclass', () => {
      const { pool } = makePool()
      expect(() => new TestConnector(BASE_CONFIG, pool)).not.toThrow()
    })
  })

  // ── _validateConfig ─────────────────────────────────────────────────────────

  describe('_validateConfig()', () => {
    it.each(['name', 'type', 'baseUrl', 'endpoint'])(
      'throws when required field "%s" is missing',
      (field) => {
        const { pool } = makePool()
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

    it('does NOT retry on a generic 4xx (e.g. 400) — fails immediately', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400 })
      await expect(connector._fetchWithRetry('http://test', {}, 'ctx'))
        .rejects.toThrow('HTTP 400')
      expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    it('does NOT retry on 404', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 })
      await expect(connector._fetchWithRetry('http://test', {}, 'ctx'))
        .rejects.toThrow('HTTP 404')
      expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    // ── H11: 401/403 re-auth-and-retry-once ──────────────────────────────────

    it('on 401, calls authenticate() once and retries the request once', async () => {
      const authenticate = jest.spyOn(connector, 'authenticate').mockResolvedValue()
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: true,  status: 200 })
      const res = await connector._fetchWithRetry('http://test', {}, 'ctx')
      expect(res.status).toBe(200)
      expect(authenticate).toHaveBeenCalledTimes(1)
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('on 403, calls authenticate() once and retries the request once', async () => {
      const authenticate = jest.spyOn(connector, 'authenticate').mockResolvedValue()
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 403 })
        .mockResolvedValueOnce({ ok: true,  status: 200 })
      const res = await connector._fetchWithRetry('http://test', {}, 'ctx')
      expect(res.status).toBe(200)
      expect(authenticate).toHaveBeenCalledTimes(1)
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('re-auth retry does NOT consume one of the normal 4 attempt slots', async () => {
      // 401 on the very first call still gets its post-reauth retry even though
      // every one of the 4 "normal" attempts below is a 503 that exhausts the
      // whole retry budget — proves the reauth path is not counted against it.
      jest.spyOn(connector, 'authenticate').mockResolvedValue()
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValue({ ok: false, status: 503 })
      await expect(connector._fetchWithRetry('http://test', {}, 'ctx'))
        .rejects.toThrow('All 4 attempts failed')
      // 1 (401) + 4 (503 exhausting MAX_ATTEMPTS) = 5
      expect(global.fetch).toHaveBeenCalledTimes(5)
    })

    it('fails as non-retriable if the retry after re-auth still gets a 401 (no infinite loop)', async () => {
      const authenticate = jest.spyOn(connector, 'authenticate').mockResolvedValue()
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 })
      await expect(connector._fetchWithRetry('http://test', {}, 'ctx'))
        .rejects.toThrow('HTTP 401')
      expect(authenticate).toHaveBeenCalledTimes(1)
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('rebuilds options from a factory on every attempt, including the post-reauth retry', async () => {
      let token = 'stale-token'
      jest.spyOn(connector, 'authenticate').mockImplementation(async () => { token = 'fresh-token' })
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: true,  status: 200 })
      const buildOptions = () => ({ headers: { 'X-Player-Token': token } })
      await connector._fetchWithRetry('http://test', buildOptions, 'ctx')
      expect(global.fetch.mock.calls[0][1].headers['X-Player-Token']).toBe('stale-token')
      expect(global.fetch.mock.calls[1][1].headers['X-Player-Token']).toBe('fresh-token')
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

    it('includes the context label in every retry log', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValue(  { ok: true,  status: 200 })
      await connector._fetchWithRetry('http://test', {}, 'agent "betcoin"')
      expect(warn.mock.calls[0][0]).toContain('agent "betcoin"')
    })
  })

  // ── insertTransactions ──────────────────────────────────────────────────────

  describe('insertTransactions()', () => {

    it('returns 0 for empty input without opening a DB connection', async () => {
      const { connector, pool } = makeConnector()
      const result = await connector.insertTransactions('ag', [])
      expect(result).toBe(0)
      expect(pool.connect).not.toHaveBeenCalled()
    })

    it('wraps all inserts in BEGIN / COMMIT on success', async () => {
      const { connector, client } = makeConnector()
      await connector.insertTransactions('ag', [txWith()])
      const ops = client.query.mock.calls.map(c => c[0].trim().split(/\s/)[0])
      expect(ops[0]).toBe('BEGIN')
      expect(ops[ops.length - 1]).toBe('COMMIT')
    })

    it('issues ROLLBACK and re-throws when an INSERT fails', async () => {
      const failingClient = makeClient({
        query: jest.fn()
          .mockResolvedValueOnce({ rowCount: 0 })        // BEGIN
          .mockRejectedValueOnce(new Error('db error'))  // INSERT fails
          .mockResolvedValue(   { rowCount: 0 }),        // ROLLBACK
      })
      const pool = { connect: jest.fn().mockResolvedValue(failingClient) }
      const connector = new TestConnector(BASE_CONFIG, pool)

      await expect(connector.insertTransactions('ag', [txWith({ id_rec: null })]))
        .rejects.toThrow('db error')

      const ops = failingClient.query.mock.calls.map(c => c[0].trim().split(/\s/)[0])
      expect(ops).toContain('ROLLBACK')
      expect(ops).not.toContain('COMMIT')
    })

    it('always releases the DB client after COMMIT', async () => {
      const { connector, client } = makeConnector()
      await connector.insertTransactions('ag', [txWith()])
      expect(client.release).toHaveBeenCalledTimes(1)
    })

    it('always releases the DB client after ROLLBACK', async () => {
      const failingClient = makeClient({
        query: jest.fn()
          .mockResolvedValueOnce({ rowCount: 0 })
          .mockRejectedValueOnce(new Error('fail'))
          .mockResolvedValue(   { rowCount: 0 }),
      })
      const pool = { connect: jest.fn().mockResolvedValue(failingClient) }
      const connector = new TestConnector(BASE_CONFIG, pool)

      await connector.insertTransactions('ag', [txWith({ id_rec: null })]).catch(() => {})
      expect(failingClient.release).toHaveBeenCalledTimes(1)
    })

    it('routes records WITH id_rec to the (platform, id_rec) conflict clause', async () => {
      const { connector, client } = makeConnector()
      await connector.insertTransactions('ag', [txWith({ id_rec: 'abc' })])
      const insertCall = client.query.mock.calls.find(c => c[0].includes('INSERT'))
      expect(insertCall[0]).toContain('ON CONFLICT (platform, id_rec)')
    })

    it('routes records WITHOUT id_rec to the platform-aware composite-key conflict clause', async () => {
      const { connector, client } = makeConnector()
      await connector.insertTransactions('ag', [txWith({ id_rec: null })])
      const insertCall = client.query.mock.calls.find(c => c[0].includes('INSERT'))
      expect(insertCall[0]).toContain('ON CONFLICT (platform, fecha, lower(username)')
    })

    it('always stamps the connector platform (config.name) on every inserted row', async () => {
      const { connector, client } = makeConnector()
      await connector.insertTransactions('ag', [txWith({ id_rec: 'abc' })])
      const insertCall = client.query.mock.calls.find(c => c[0].includes('INSERT'))
      // BASE_CONFIG.name === 'test' — last positional param for the id_rec path
      expect(insertCall[1]).toContain('test')
    })

    // ── fase 2: identity collisions (source_id) ────────────────────────────

    describe('_assertNoIdentityCollisions() — fase 2 (source_id)', () => {
      it('does NOT flag a collision when a plain JS number (Zeus-style monto) matches a Postgres NUMERIC string read back as "100.00"', async () => {
        // Regression guard: node-pg returns NUMERIC columns as strings
        // ("100.00"), while a connector might normalize monto as a plain JS
        // number (100, Zeus) or a fixed-decimal string ("100.00", Argenbet).
        // A naive String(a) !== String(b) would treat "100.00" and 100 as
        // different and misfire as a collision on every single Zeus re-sync.
        // `agente` on the persisted row is always insertTransactions()'s own
        // `agente` argument ('ag' below), never tx.agente — so the DB fixture
        // must agree with 'ag' here to isolate the monto canonicalization
        // being tested.
        const existingRow = { id_rec: 'r1', fecha: '2025-01-01', agente: 'ag', source_id: null, monto: '100.00', username: 'player1', tipo: 'carga' }
        const client = makeClient({
          query: jest.fn()
            .mockResolvedValueOnce({ rowCount: 0 })                 // BEGIN
            .mockResolvedValueOnce({ rowCount: 0 })                 // advisory lock
            .mockResolvedValueOnce({ rows: [existingRow] })         // collision-check SELECT
            .mockResolvedValueOnce({ rows: [{ inserted: true }] })  // INSERT
            .mockResolvedValueOnce({ rowCount: 0 }),                // COMMIT
        })
        const pool = { connect: jest.fn().mockResolvedValue(client) }
        const connector = new TestConnector(BASE_CONFIG, pool)

        await expect(
          connector.insertTransactions('ag', [txWith({ id_rec: 'r1', monto: 100, username: 'player1', tipo: 'carga' })])
        ).resolves.not.toThrow()
      })

      it('throws when an existing row disagrees on monto even after canonicalizing decimals', async () => {
        const existingRow = { id_rec: 'r1', fecha: '2025-01-01', agente: 'ag', source_id: null, monto: '100.00', username: 'player1', tipo: 'carga' }
        const client = makeClient({
          query: jest.fn()
            .mockResolvedValueOnce({ rowCount: 0 })  // BEGIN
            .mockResolvedValueOnce({ rowCount: 0 })  // advisory lock
            .mockResolvedValueOnce({ rows: [existingRow] })
            .mockResolvedValue({ rowCount: 0 }),
        })
        const pool = { connect: jest.fn().mockResolvedValue(client) }
        const connector = new TestConnector(BASE_CONFIG, pool)

        await expect(
          connector.insertTransactions('ag', [txWith({ id_rec: 'r1', monto: 999.99, username: 'player1', tipo: 'carga' })])
        ).rejects.toThrow(/identity collision/)
      })

      it('the ON CONFLICT clause only backfills fecha_hora_utc/source_id when the existing row is actually missing them (never counts a no-op replay as an update)', async () => {
        const { connector, client } = makeConnector()
        await connector.insertTransactions('ag', [txWith({ id_rec: 'abc' })])
        const insertCall = client.query.mock.calls.find(c => c[0].includes('INSERT'))
        expect(insertCall[0]).toMatch(/WHERE \(casino_transactions\.fecha_hora_utc IS NULL AND EXCLUDED\.fecha_hora_utc IS NOT NULL\)/)
        expect(insertCall[0]).toMatch(/OR \(casino_transactions\.source_id IS NULL AND EXCLUDED\.source_id IS NOT NULL\)/)
      })
    })

    // ── fase 2 fix #1: exact decimal canonicalization (no Number/toFixed) ──

    describe('_montoEquals() / _canonicalMonto() — exact decimal canonicalization', () => {
      it('treats "100.00" and 100 as equal (Zeus number vs Postgres NUMERIC string)', () => {
        const { connector } = makeConnector()
        expect(connector._montoEquals('100.00', 100)).toBe(true)
      })

      it('treats "123.40" and 123.4 as equal after stripping trailing fraction zeros', () => {
        const { connector } = makeConnector()
        expect(connector._montoEquals('123.40', 123.4)).toBe(true)
      })

      it('treats two large decimals that differ only past Number precision as DIFFERENT (never rounds through Number/toFixed)', () => {
        const { connector } = makeConnector()
        expect(connector._montoEquals('9007199254740991.01', '9007199254740991.02')).toBe(false)
      })

      it('never treats null/invalid monto as equal, even to another invalid value', () => {
        const { connector } = makeConnector()
        expect(connector._montoEquals(null, null)).toBe(false)
        expect(connector._montoEquals(undefined, 100)).toBe(false)
        expect(connector._montoEquals('not-a-number', 'not-a-number')).toBe(false)
      })
    })

    // ── fase 2 fix #2: fecha/agente are part of identity ────────────────────

    describe('_identityConflicts() — fecha/agente are part of identity', () => {
      it('throws when an existing row disagrees only on fecha (same monto/username/tipo/agente)', async () => {
        const existingRow = { id_rec: 'r1', fecha: '2025-01-02', agente: 'ag', source_id: null, monto: '100.00', username: 'player1', tipo: 'carga' }
        const client = makeClient({
          query: jest.fn()
            .mockResolvedValueOnce({ rowCount: 0 })  // BEGIN
            .mockResolvedValueOnce({ rowCount: 0 })  // advisory lock
            .mockResolvedValueOnce({ rows: [existingRow] })
            .mockResolvedValue({ rowCount: 0 }),
        })
        const pool = { connect: jest.fn().mockResolvedValue(client) }
        const connector = new TestConnector(BASE_CONFIG, pool)

        await expect(
          connector.insertTransactions('ag', [txWith({ id_rec: 'r1', fecha: '2025-01-01', monto: 100, username: 'player1', tipo: 'carga' })])
        ).rejects.toThrow(/identity collision/)
      })

      it('throws when an existing row disagrees only on agente (same fecha/monto/username/tipo)', async () => {
        // `agente` on the persisted row is insertTransactions()'s own `agente`
        // argument ('ag' below), never tx.agente — 'other-agente' here
        // simulates a row that was originally inserted under a different
        // agente argument.
        const existingRow = { id_rec: 'r1', fecha: '2025-01-01', agente: 'other-agente', source_id: null, monto: '100.00', username: 'player1', tipo: 'carga' }
        const client = makeClient({
          query: jest.fn()
            .mockResolvedValueOnce({ rowCount: 0 })  // BEGIN
            .mockResolvedValueOnce({ rowCount: 0 })  // advisory lock
            .mockResolvedValueOnce({ rows: [existingRow] })
            .mockResolvedValue({ rowCount: 0 }),
        })
        const pool = { connect: jest.fn().mockResolvedValue(client) }
        const connector = new TestConnector(BASE_CONFIG, pool)

        await expect(
          connector.insertTransactions('ag', [txWith({ id_rec: 'r1', fecha: '2025-01-01', monto: 100, username: 'player1', tipo: 'carga' })])
        ).rejects.toThrow(/identity collision/)
      })

      it('does NOT flag a collision when agente only differs by case/whitespace (normalized trim+lowercase)', async () => {
        const existingRow = { id_rec: 'r1', fecha: '2025-01-01', agente: '  AG ', source_id: null, monto: '100.00', username: 'player1', tipo: 'carga' }
        const client = makeClient({
          query: jest.fn()
            .mockResolvedValueOnce({ rowCount: 0 })  // BEGIN
            .mockResolvedValueOnce({ rowCount: 0 })  // advisory lock
            .mockResolvedValueOnce({ rows: [existingRow] })
            .mockResolvedValueOnce({ rows: [{ inserted: true }] })
            .mockResolvedValueOnce({ rowCount: 0 }),
        })
        const pool = { connect: jest.fn().mockResolvedValue(client) }
        const connector = new TestConnector(BASE_CONFIG, pool)

        await expect(
          connector.insertTransactions('ag', [txWith({ id_rec: 'r1', fecha: '2025-01-01', monto: 100, username: 'player1', tipo: 'carga' })])
        ).resolves.not.toThrow()
      })

      it('throws on two rows in the SAME batch sharing an id_rec but disagreeing on fecha (not just against the DB)', async () => {
        const { connector } = makeConnector()
        const txA = txWith({ id_rec: 'dup1', fecha: '2025-01-01' })
        const txB = txWith({ id_rec: 'dup1', fecha: '2025-01-02' })
        await expect(connector.insertTransactions('ag', [txA, txB]))
          .rejects.toThrow(/identity collision within the same batch/)
      })
    })

    // ── fase 2 fix #3: insertedTxCount counts only real INSERTs ─────────────

    describe('insertedTxCount — counts only real INSERTs (RETURNING xmax=0), never a backfill-only UPDATE', () => {
      it('counts 0 for a WITH-id_rec row whose ON CONFLICT branch only backfilled columns (Zeus-style replay)', async () => {
        const client = makeClient({
          query: jest.fn()
            .mockResolvedValueOnce({ rowCount: 0 })                    // BEGIN
            .mockResolvedValueOnce({ rowCount: 0 })                    // advisory lock
            .mockResolvedValueOnce({ rows: [] })                       // collision-check SELECT
            .mockResolvedValueOnce({ rows: [{ inserted: false }] })    // INSERT: backfill only
            .mockResolvedValueOnce({ rowCount: 0 }),                   // COMMIT
        })
        const pool = { connect: jest.fn().mockResolvedValue(client) }
        const connector = new TestConnector(BASE_CONFIG, pool)

        const result = await connector.insertTransactions('ag', [txWith({ id_rec: 'abc' })])
        expect(result).toBe(0)
      })

      it('counts 1 for a WITH-id_rec row that RETURNING reports as a genuine insert', async () => {
        const client = makeClient({
          query: jest.fn()
            .mockResolvedValueOnce({ rowCount: 0 })
            .mockResolvedValueOnce({ rowCount: 0 })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ inserted: true }] })
            .mockResolvedValueOnce({ rowCount: 0 }),
        })
        const pool = { connect: jest.fn().mockResolvedValue(client) }
        const connector = new TestConnector(BASE_CONFIG, pool)

        const result = await connector.insertTransactions('ag', [txWith({ id_rec: 'abc' })])
        expect(result).toBe(1)
      })

      it('counts 0 for a WITHOUT-id_rec row (Zeus/Bet30, no source_id) whose ON CONFLICT branch only backfilled fecha_hora_utc — a replay of the same window must never look like new data', async () => {
        const client = makeClient({
          query: jest.fn()
            .mockResolvedValueOnce({ rowCount: 0 })                    // BEGIN
            .mockResolvedValueOnce({ rowCount: 0 })                    // advisory lock
            .mockResolvedValueOnce({ rows: [{ inserted: false }] })    // INSERT: backfill only
            .mockResolvedValueOnce({ rowCount: 0 }),                   // COMMIT
        })
        const pool = { connect: jest.fn().mockResolvedValue(client) }
        const connector = new TestConnector(BASE_CONFIG, pool)

        const result = await connector.insertTransactions('ag', [txWith({ id_rec: null })])
        expect(result).toBe(0)
      })
    })

    // ── fase 2 fix #3b: intra-batch dedup for id_rec-less rows too ──────────

    describe('_dedupeIntraBatchWithoutId() — collapses exact duplicates for id_rec-less rows', () => {
      it('collapses two identical without-id_rec rows into a single INSERT VALUES entry', async () => {
        const { connector, client } = makeConnector()
        await connector.insertTransactions('ag', [txWith({ id_rec: null }), txWith({ id_rec: null })])
        const insertCall = client.query.mock.calls.find(c => c[0].includes('ON CONFLICT (platform, fecha, lower(username)'))
        expect(insertCall[1].length).toBe(9) // one row's worth of params, not two
      })

      it('collapses duplicates even when monto is given as a number vs the equivalent NUMERIC string', async () => {
        const { connector, client } = makeConnector()
        await connector.insertTransactions('ag', [
          txWith({ id_rec: null, monto: 100 }),
          txWith({ id_rec: null, monto: '100.00' }),
        ])
        const insertCall = client.query.mock.calls.find(c => c[0].includes('ON CONFLICT (platform, fecha, lower(username)'))
        expect(insertCall[1].length).toBe(9)
      })

      it('throws when two without-id_rec rows share the same identity but disagree on source_id', async () => {
        const { connector } = makeConnector()
        const txA = txWith({ id_rec: null, source_id: 'a' })
        const txB = txWith({ id_rec: null, source_id: 'b' })
        await expect(connector.insertTransactions('ag', [txA, txB]))
          .rejects.toThrow(/identity collision within the same batch/)
      })
    })

    // ── fase 2 fix #4: advisory lock covers ALL API ingestion, not just source_id ──

    describe('advisory lock — unconditional, covers Zeus/Bet30 (no source_id) too', () => {
      it('acquires the same named advisory lock the Excel importer uses even for a batch with no source_id at all', async () => {
        const { connector, client } = makeConnector()
        await connector.insertTransactions('ag', [txWith({ id_rec: null })]) // txWith() carries no source_id
        const ops = client.query.mock.calls.map(c => c[0].trim())
        const beginIdx = ops.findIndex(q => q.startsWith('BEGIN'))
        const lockIdx  = ops.findIndex(q => q.includes('pg_advisory_xact_lock'))
        const insertIdx = ops.findIndex(q => q.includes('INSERT INTO casino_transactions'))
        expect(lockIdx).toBeGreaterThan(beginIdx)
        expect(lockIdx).toBeLessThan(insertIdx)
        expect(ops[lockIdx]).toContain("hashtext('casino-excel-import')")
      })

      it('never issues the advisory-lock query outside the BEGIN/COMMIT transaction', async () => {
        const { connector, client, pool } = makeConnector()
        await connector.insertTransactions('ag', [txWith({ id_rec: null })])
        expect(pool.query).not.toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'))
        expect(client.query.mock.calls.some(c => c[0].includes('pg_advisory_xact_lock'))).toBe(true)
      })
    })
  })

  // ── recomputePlayers ───────────────────────────────────────────────────────
  //
  // D1/D2 (H1/H2/H3): casino_players is fully recomputed from casino_transactions
  // in a single SQL statement — no JS-side money arithmetic, no accumulation.
  // These tests assert the STRUCTURE of that statement against the spec
  // (assignment not increment, platform+username scope not agente scope,
  // deposit-only activity dates, deterministic agente tie-break). End-to-end
  // idempotency / cross-agent / cross-platform semantics are covered
  // separately in recompute.test.js against a fake in-memory Postgres, since a
  // structural check alone can't prove the aggregate math is right.

  describe('recomputePlayers()', () => {

    it('returns 0 and skips the query when there are no normalized transactions', async () => {
      const { connector, pool } = makeConnector()
      const result = await connector.recomputePlayers([])
      expect(result).toBe(0)
      expect(pool.query).not.toHaveBeenCalled()
    })

    it('issues a single INSERT ... SELECT scoped by platform and the touched usernames (not agente)', async () => {
      const { connector, pool } = makeConnector()
      await connector.recomputePlayers([
        { username: 'p1' }, { username: 'P1' }, { username: 'p2' },
      ])
      expect(pool.query).toHaveBeenCalledTimes(1)
      const [sql, params] = pool.query.mock.calls[0]
      expect(sql).toContain('INSERT INTO casino_players')
      expect(sql).toContain('FROM casino_transactions')
      expect(sql).not.toMatch(/WHERE[^;]*\bagente\s*=\s*\$2/)
      expect(params[0]).toBe('test') // platform = config.name
      expect(params[1].sort()).toEqual(['p1', 'p2']) // deduped, lowercased
    })

    it('uses assignment (EXCLUDED.x), never accumulation, on conflict', async () => {
      const { connector, pool } = makeConnector()
      await connector.recomputePlayers([{ username: 'p1' }])
      const [sql] = pool.query.mock.calls[0]
      expect(sql).toContain('ON CONFLICT (platform, username_lower)')
      expect(sql).toContain('total_cargas  = EXCLUDED.total_cargas')
      expect(sql).not.toMatch(/total_cargas\s*=\s*casino_players\.total_cargas\s*\+/)
    })

    it('computes totals with SQL SUM(...)::numeric-safe aggregates, not JS arithmetic', async () => {
      const { connector, pool } = makeConnector()
      await connector.recomputePlayers([{ username: 'p1' }])
      const [sql] = pool.query.mock.calls[0]
      expect(sql).toMatch(/SUM\(monto\)\s*FILTER\s*\(WHERE tipo = 'carga'\)/)
      expect(sql).toMatch(/SUM\(monto\)\s*FILTER\s*\(WHERE tipo = 'retiro'\)/)
    })

    it('restricts fecha_primera/fecha_ultima to deposits only (a withdrawal must not reactivate a player)', async () => {
      const { connector, pool } = makeConnector()
      await connector.recomputePlayers([{ username: 'p1' }])
      const [sql] = pool.query.mock.calls[0]
      expect(sql).toMatch(/MIN\(fecha\)\s*FILTER\s*\(WHERE tipo = 'carga'\)/)
      expect(sql).toMatch(/MAX\(fecha\)\s*FILTER\s*\(WHERE tipo = 'carga'\)/)
    })

    it('picks agente deterministically from the most recent transaction, not from the fetched batch', async () => {
      const { connector, pool } = makeConnector()
      await connector.recomputePlayers([{ username: 'p1' }])
      const [sql] = pool.query.mock.calls[0]
      expect(sql).toMatch(/array_agg\(agente\s+ORDER BY COALESCE\(fecha_hora_utc, fecha::timestamptz\) DESC, id DESC\)/)
    })
  })

  describe('syncAgent()', () => {
    // Fase 4 critical-bug fix: insertTransactions() and recomputePlayers() are
    // two SEPARATE DB calls (the first commits its own transaction before the
    // second even starts) — if recompute fails, the caller (the orchestrator)
    // needs to know transactions genuinely landed so it can persist that on
    // the failed casino_sync_runs row, and so incrementalWindow's recovery
    // checkpoint can widen desde back to this exact range on the next run
    // instead of skipping past it via a MAX(fecha_hora_utc) watermark that
    // already moved forward.
    it('attaches insertedTxCount to the thrown error when recomputePlayers() fails after insertTransactions() already committed', async () => {
      const { connector } = makeConnector()
      jest.spyOn(connector, 'fetchTransactions').mockResolvedValue([{ username: 'p1' }])
      jest.spyOn(connector, 'insertTransactions').mockResolvedValue(5)
      jest.spyOn(connector, 'recomputePlayers').mockRejectedValue(new Error('recompute exploded'))

      await expect(connector.syncAgent('agente1', '2025-01-01', '2025-01-02')).rejects.toMatchObject({
        message:               'recompute exploded',
        insertedTxCount:       5,
        recomputePlayersFailed: true,
      })
    })

    it('returns the real insertedTxCount and playerCount when everything succeeds', async () => {
      const { connector } = makeConnector()
      jest.spyOn(connector, 'fetchTransactions').mockResolvedValue([{ username: 'p1' }, { username: 'p2' }])
      jest.spyOn(connector, 'insertTransactions').mockResolvedValue(2)
      jest.spyOn(connector, 'recomputePlayers').mockResolvedValue(2)

      const result = await connector.syncAgent('agente1', '2025-01-01', '2025-01-02')
      expect(result).toEqual({ txCount: 2, playerCount: 2, insertedTxCount: 2 })
    })
  })
})
