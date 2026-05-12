'use strict'

const { ZeusConnector } = require('../../src/casino-connectors/zeus/ZeusConnector')

// ── Factories ─────────────────────────────────────────────────────────────────

const CONFIG = {
  name:              'zeus',
  type:              'zeus',
  baseUrl:           'https://local-admin2.zeuscasino.fun',
  baseUrlEnvVar:     'ZEUS_API_BASE',
  apiKeyEnvVar:      'ZEUS_API_KEY',
  playerTokenEnvVar: 'ZEUS_PLAYER_TOKEN',
  endpoint:          '/api/records/movimiento-fichas',
  timezone:          '-03',
}

function makePool() {
  const client = {
    query:   jest.fn().mockResolvedValue({ rowCount: 0 }),
    release: jest.fn(),
  }
  return {
    pool: { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rowCount: 0 }) },
    client,
  }
}

function makeConnector() {
  const { pool } = makePool()
  return new ZeusConnector(CONFIG, pool)
}

// Raw Zeus transaction with sensible defaults
function rawTx(overrides = {}) {
  return {
    id:               'r1',
    username:         'player1',
    creator_username: 'betcoin',
    valor:            -500,
    detalles:         'Carga directa',
    fecha:            '2025-03-15T05:00:00.000Z',
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ZeusConnector', () => {

  beforeEach(() => {
    process.env.ZEUS_API_KEY      = 'test-api-key'
    process.env.ZEUS_PLAYER_TOKEN = 'test-player-token'
    delete process.env.ZEUS_API_BASE
    // Skip retry delays
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0 })
  })
  afterEach(() => jest.restoreAllMocks())

  // ── constructor ─────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('throws when ZEUS_API_KEY is missing', () => {
      delete process.env.ZEUS_API_KEY
      const { pool } = makePool()
      expect(() => new ZeusConnector(CONFIG, pool)).toThrow('ZEUS_API_KEY')
    })

    it('throws when ZEUS_PLAYER_TOKEN is missing', () => {
      delete process.env.ZEUS_PLAYER_TOKEN
      const { pool } = makePool()
      expect(() => new ZeusConnector(CONFIG, pool)).toThrow('ZEUS_PLAYER_TOKEN')
    })

    it('uses ZEUS_API_BASE env var when provided', () => {
      process.env.ZEUS_API_BASE = 'https://custom.zeus.internal'
      expect(makeConnector().baseUrl).toBe('https://custom.zeus.internal')
    })

    it('falls back to config.baseUrl when ZEUS_API_BASE is absent', () => {
      expect(makeConnector().baseUrl).toBe('https://local-admin2.zeuscasino.fun')
    })

    it('stores trimmed credentials', () => {
      process.env.ZEUS_API_KEY      = '  my-key  '
      process.env.ZEUS_PLAYER_TOKEN = '  my-token  '
      const c = makeConnector()
      expect(c.apiKey).toBe('my-key')
      expect(c.playerToken).toBe('my-token')
    })
  })

  // ── fetchTransactions ───────────────────────────────────────────────────────

  describe('fetchTransactions()', () => {
    let connector

    beforeEach(() => {
      connector = makeConnector()
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => [],
      })
    })

    it('sends X-Api-Key and X-Player-Token headers', async () => {
      await connector.fetchTransactions('ag', '2025-01-01', '2025-01-31')
      const [, opts] = global.fetch.mock.calls[0]
      expect(opts.headers['X-Api-Key']).toBe('test-api-key')
      expect(opts.headers['X-Player-Token']).toBe('test-player-token')
    })

    it('includes username, startDate, endDate and timezone in URL', async () => {
      await connector.fetchTransactions('betcoin', '2025-01-01', '2025-01-31')
      const [url] = global.fetch.mock.calls[0]
      expect(url).toContain('username=betcoin')
      expect(url).toContain('startDate=')
      expect(url).toContain('endDate=')
      expect(url).toContain('timezone=-03')
    })

    it('adds one day to endDate (exclusive upper bound)', async () => {
      await connector.fetchTransactions('ag', '2025-01-01', '2025-01-31')
      const [url] = global.fetch.mock.calls[0]
      // Jan 31 → Feb 01
      expect(url).toContain('2025-02-01')
    })

    it('unwraps an array response directly', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => [{ id: '1' }],
      })
      expect(await connector.fetchTransactions('ag', '2025-01-01', '2025-01-31'))
        .toEqual([{ id: '1' }])
    })

    it('unwraps a { data: [...] } response envelope', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => ({ data: [{ id: '2' }] }),
      })
      expect(await connector.fetchTransactions('ag', '2025-01-01', '2025-01-31'))
        .toEqual([{ id: '2' }])
    })

    it('unwraps a { records: [...] } response envelope', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => ({ records: [{ id: '3' }] }),
      })
      expect(await connector.fetchTransactions('ag', '2025-01-01', '2025-01-31'))
        .toEqual([{ id: '3' }])
    })

    it('returns empty array for unrecognised response shape', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => ({ unknown: 'shape' }),
      })
      expect(await connector.fetchTransactions('ag', '2025-01-01', '2025-01-31'))
        .toEqual([])
    })

    it('propagates errors from _fetchWithRetry after all retries', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 })
      await expect(connector.fetchTransactions('ag', '2025-01-01', '2025-01-31'))
        .rejects.toThrow('All 4 attempts failed')
    })
  })

  // ── normalizeTransactions ───────────────────────────────────────────────────

  describe('normalizeTransactions()', () => {
    let connector

    beforeEach(() => connector = makeConnector())

    it('maps a valid carga transaction to the standard shape', async () => {
      const [result] = await connector.normalizeTransactions([rawTx()])
      expect(result).toMatchObject({
        id_rec:       'r1',
        username:     'player1',
        agente:       'betcoin',
        tipo:         'carga',
        monto:        500,
        raw_detalles: 'Carga directa',
      })
    })

    it('detects "retiro" tipo from detalles (case-insensitive)', async () => {
      const [result] = await connector.normalizeTransactions([
        rawTx({ detalles: 'Retiro directo', valor: 200 }),
      ])
      expect(result.tipo).toBe('retiro')
      expect(result.monto).toBe(200)
    })

    it('stores monto as absolute rounded value regardless of valor sign', async () => {
      const [pos] = await connector.normalizeTransactions([rawTx({ valor:  300 })])
      const [neg] = await connector.normalizeTransactions([rawTx({ valor: -300 })])
      expect(pos.monto).toBe(300)
      expect(neg.monto).toBe(300)
    })

    it('filters out transactions containing "indirecto" in detalles', async () => {
      expect(await connector.normalizeTransactions([
        rawTx({ detalles: 'Carga indirecto' }),
      ])).toHaveLength(0)
    })

    it('filters out transactions with an unrecognised tipo', async () => {
      expect(await connector.normalizeTransactions([
        rawTx({ detalles: 'Ajuste de balance' }),
      ])).toHaveLength(0)
    })

    it('filters out transactions with no username', async () => {
      expect(await connector.normalizeTransactions([rawTx({ username: null })])).toHaveLength(0)
    })

    it('filters out transactions with no fecha', async () => {
      expect(await connector.normalizeTransactions([rawTx({ fecha: null })])).toHaveLength(0)
    })

    it('converts UTC to Argentina date (UTC-3, no DST): same-day scenario', async () => {
      // 2025-03-15 05:00 UTC = 2025-03-15 02:00 ART → same calendar day
      const [result] = await connector.normalizeTransactions([
        rawTx({ fecha: '2025-03-15T05:00:00.000Z' }),
      ])
      expect(result.fecha).toBe('2025-03-15')
    })

    it('converts UTC to Argentina date: late UTC shifts to previous ART day', async () => {
      // 2025-03-16T01:30:00Z = 2025-03-15T22:30 ART → previous calendar day
      const [result] = await connector.normalizeTransactions([
        rawTx({ fecha: '2025-03-16T01:30:00.000Z' }),
      ])
      expect(result.fecha).toBe('2025-03-15')
    })

    it('preserves id_rec as null when the platform does not provide one', async () => {
      const [result] = await connector.normalizeTransactions([rawTx({ id: null })])
      expect(result.id_rec).toBeNull()
    })

    it('sets fecha_hora_utc from timestamps that include a time component', async () => {
      const [result] = await connector.normalizeTransactions([
        rawTx({ fecha: '2025-03-15T05:00:00.000Z' }),
      ])
      expect(result.fecha_hora_utc).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('sets fecha_hora_utc to null for date-only strings', async () => {
      const [result] = await connector.normalizeTransactions([
        rawTx({ fecha: '2025-03-15' }),
      ])
      expect(result.fecha_hora_utc).toBeNull()
    })

    it('processes a batch of transactions, filtering correctly', async () => {
      const raw = [
        rawTx({ id: 'a', detalles: 'Carga directa' }),
        rawTx({ id: 'b', detalles: 'Retiro directo' }),
        rawTx({ id: 'c', detalles: 'Carga indirecto' }),  // excluded
        rawTx({ id: 'd', detalles: 'Ajuste'          }),  // excluded
      ]
      const result = await connector.normalizeTransactions(raw)
      expect(result).toHaveLength(2)
      expect(result.map(r => r.id_rec).sort()).toEqual(['a', 'b'])
    })
  })

  // ── healthCheck ─────────────────────────────────────────────────────────────

  describe('healthCheck()', () => {
    let connector

    beforeEach(() => connector = makeConnector())

    it('returns true when the API gateway responds with 200', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 })
      expect(await connector.healthCheck()).toBe(true)
    })

    it('returns true for 404 — API is reachable even if agent not found', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 })
      expect(await connector.healthCheck()).toBe(true)
    })

    it('returns false for 5xx — server error', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 })
      expect(await connector.healthCheck()).toBe(false)
    })

    it('returns false when fetch throws (network unreachable)', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      expect(await connector.healthCheck()).toBe(false)
    })
  })
})
