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

    it('routes records WITH id_rec to the id_rec-keyed conflict clause', async () => {
      const { connector, client } = makeConnector()
      await connector.insertTransactions('ag', [txWith({ id_rec: 'abc' })])
      const insertCall = client.query.mock.calls.find(c => c[0].includes('INSERT'))
      expect(insertCall[0]).toContain('ON CONFLICT (id_rec)')
    })

    it('routes records WITHOUT id_rec to the composite-key conflict clause', async () => {
      const { connector, client } = makeConnector()
      await connector.insertTransactions('ag', [txWith({ id_rec: null })])
      const insertCall = client.query.mock.calls.find(c => c[0].includes('INSERT'))
      expect(insertCall[0]).toContain('ON CONFLICT (fecha, username')
    })
  })

  // ── aggregate ───────────────────────────────────────────────────────────────

  describe('aggregate()', () => {
    let connector

    beforeEach(() => ({ connector } = makeConnector()))

    it('sums cargas and retiros separately per player', () => {
      const normalized = [
        { username: 'p1', agente: 'ag', monto: 500, tipo: 'carga',  fecha: '2025-01-01' },
        { username: 'p1', agente: 'ag', monto: 200, tipo: 'retiro', fecha: '2025-01-02' },
        { username: 'p1', agente: 'ag', monto: 300, tipo: 'carga',  fecha: '2025-01-03' },
      ]
      const [p1] = connector.aggregate(normalized)
      expect(p1.total_cargas).toBe(800)
      expect(p1.total_retiros).toBe(200)
      expect(p1.cant_cargas).toBe(2)
      expect(p1.cant_retiros).toBe(1)
    })

    it('tracks fecha_primera (min) and fecha_ultima (max) correctly', () => {
      const normalized = [
        { username: 'p1', agente: 'ag', monto: 100, tipo: 'carga', fecha: '2025-03-15' },
        { username: 'p1', agente: 'ag', monto: 100, tipo: 'carga', fecha: '2025-01-01' },
        { username: 'p1', agente: 'ag', monto: 100, tipo: 'carga', fecha: '2025-06-30' },
      ]
      const [p1] = connector.aggregate(normalized)
      expect(p1.fecha_primera).toBe('2025-01-01')
      expect(p1.fecha_ultima).toBe('2025-06-30')
    })

    it('handles multiple players independently', () => {
      const normalized = [
        { username: 'p1', agente: 'ag', monto: 100, tipo: 'carga',  fecha: '2025-01-01' },
        { username: 'p2', agente: 'ag', monto: 200, tipo: 'retiro', fecha: '2025-01-01' },
      ]
      const players = connector.aggregate(normalized)
      expect(players).toHaveLength(2)
      expect(players.find(p => p.username === 'p1').total_cargas).toBe(100)
      expect(players.find(p => p.username === 'p2').total_retiros).toBe(200)
    })

    it('skips entries with empty username', () => {
      const normalized = [
        { username: '',   agente: 'ag', monto: 100, tipo: 'carga', fecha: '2025-01-01' },
        { username: 'p1', agente: 'ag', monto: 100, tipo: 'carga', fecha: '2025-01-01' },
      ]
      expect(connector.aggregate(normalized)).toHaveLength(1)
    })

    it('skips entries with empty agente', () => {
      const normalized = [
        { username: 'p1', agente: '', monto: 100, tipo: 'carga', fecha: '2025-01-01' },
        { username: 'p2', agente: 'ag', monto: 100, tipo: 'carga', fecha: '2025-01-01' },
      ]
      expect(connector.aggregate(normalized)).toHaveLength(1)
    })

    it('returns an empty array for empty input', () => {
      expect(connector.aggregate([])).toEqual([])
    })
  })

  // ── upsertPlayers ───────────────────────────────────────────────────────────

  describe('upsertPlayers()', () => {

    it('returns 0 and skips DB when player list is empty', async () => {
      const { connector, pool } = makeConnector()
      const result = await connector.upsertPlayers([])
      expect(result).toBe(0)
      expect(pool.connect).not.toHaveBeenCalled()
    })

    it('issues one INSERT per player', async () => {
      const { connector, client } = makeConnector()
      await connector.upsertPlayers([
        { username: 'p1', agente: 'ag', total_cargas: 100, total_retiros: 0, cant_cargas: 1, cant_retiros: 0, fecha_primera: '2025-01-01', fecha_ultima: '2025-01-01' },
        { username: 'p2', agente: 'ag', total_cargas: 200, total_retiros: 0, cant_cargas: 2, cant_retiros: 0, fecha_primera: '2025-01-01', fecha_ultima: '2025-01-01' },
      ])
      const insertCalls = client.query.mock.calls.filter(c => c[0].includes('INSERT'))
      expect(insertCalls).toHaveLength(2)
    })

    it('uses ON CONFLICT (username_lower) for upsert', async () => {
      const { connector, client } = makeConnector()
      await connector.upsertPlayers([
        { username: 'p1', agente: 'ag', total_cargas: 100, total_retiros: 0, cant_cargas: 1, cant_retiros: 0, fecha_primera: null, fecha_ultima: null },
      ])
      const [sql] = client.query.mock.calls[0]
      expect(sql).toContain('ON CONFLICT (username_lower)')
    })

    it('returns the number of players processed', async () => {
      const { connector } = makeConnector()
      const players = Array.from({ length: 5 }, (_, i) => ({
        username: `p${i}`, agente: 'ag', total_cargas: 0, total_retiros: 0,
        cant_cargas: 0, cant_retiros: 0, fecha_primera: null, fecha_ultima: null,
      }))
      expect(await connector.upsertPlayers(players)).toBe(5)
    })
  })
})
