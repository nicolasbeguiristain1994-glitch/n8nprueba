'use strict'

const { ZeusConnector } = require('../../src/casino-connectors/zeus/ZeusConnector')
const { Bet30Connector } = require('../../src/casino-connectors/bet30/Bet30Connector')

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

    it('accepts an empty array as a valid "no movements" answer', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ result: [] }) })
      expect(await connector.fetchTransactions('ag', '2025-01-01', '2025-01-31')).toEqual([])
    })

    it.each([
      [{ unknown: 'shape' }],
      [{ error: 'token expired' }],
      [{ message: 'maintenance' }],
      [{ data: 'not-an-array' }],
      [{ data: null, records: [] }],
      [null],
      ['texto'],
    ])('rejects a 200 with unknown body %p as INVALID_RESPONSE (never as [])', async body => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })
      await expect(connector.fetchTransactions('ag', '2025-01-01', '2025-01-31'))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    })

    it('rejects a non-JSON body without echoing it', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200,
        json: async () => { throw new SyntaxError('Unexpected token < in "<html>secret-page-content"') },
      })
      const err = await connector.fetchTransactions('ag', '2025-01-01', '2025-01-31').catch(e => e)
      expect(err.code).toBe('INVALID_RESPONSE')
      expect(err.message).not.toMatch(/secret-page-content/)
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

    it.each(['bono', 'BONO', 'Bonos', 'Bono promocional', 'Promoción: [BONOS]', 'bono.'])('counts standalone bonus description %s as a deposit', async detalles => {
      const r = await connector.normalizeWithStats([
        rawTx({ id: '501', detalles, valor: -125.6, fecha: '2026-09-15T01:30:00.000Z' }),
      ])
      expect(r).toEqual({ rows: [{
        id_rec: '501', username: 'player1', agente: 'betcoin', tipo: 'carga', monto: 126,
        fecha: '2026-09-14', fecha_hora_utc: '2026-09-15T01:30:00.000Z', raw_detalles: detalles,
      }], invalid: 0, excluded: 0 })
    })

    it.each(['abono', 'Abonos', 'abonogeneral', 'Juanbono', 'Josébono', 'bonoé', 'bono_player', 'bonos123', 'bonovip', 'a\u0301bono'])('does not infer a bonus from a substring or identifier: %s', async detalles => {
      const r = await connector.normalizeWithStats([rawTx({ detalles })])
      expect(r).toEqual({ rows: [], invalid: 1, excluded: 0 })
    })

    it.each([
      ['Retiro de bono', 'retiro'], ['retiro de BONOS', 'retiro'],
      ['Carga de bono', 'carga'], ['Carga y retiro de bonos', 'carga'],
    ])('preserves existing carga/retiro priority for %s', async (detalles, tipo) => {
      const r = await connector.normalizeWithStats([rawTx({ detalles })])
      expect(r.invalid).toBe(0)
      expect(r.rows[0].tipo).toBe(tipo)
    })

    it('retains expected indirecto exclusions and unknown-type failures in a synthetic mixed batch', async () => {
      const r = await connector.normalizeWithStats([
        rawTx({ id: '101', detalles: 'Carga directa' }),
        rawTx({ id: '102', detalles: 'Retiro directo' }),
        rawTx({ id: '103', detalles: 'Bono' }),
        rawTx({ id: '104', detalles: 'Bonos' }),
        rawTx({ id: '105', detalles: 'Bono indirecto' }),
        rawTx({ id: '106', detalles: 'Ajuste de balance' }),
      ])
      expect(r.rows.map(row => [row.id_rec, row.tipo])).toEqual([
        ['101', 'carga'], ['102', 'retiro'], ['103', 'carga'], ['104', 'carga'],
      ])
      expect(r.excluded).toBe(1)
      expect(r.invalid).toBe(1)
      expect(r.rows.length + r.invalid + r.excluded).toBe(6)
    })

    it.each([
      { username: null }, { fecha: null }, { valor: 'not-a-number' },
    ])('still rejects invalid bonus rows: %p', async overrides => {
      expect(await connector.normalizeWithStats([rawTx({ detalles: 'Bono', ...overrides })]))
        .toEqual({ rows: [], invalid: 1, excluded: 0 })
    })

    it('keeps bonus IDs subject to existing dedup and no-ID limitations', async () => {
      const r = await connector.normalizeWithStats([
        rawTx({ id: '701', detalles: 'Bono' }),
        rawTx({ id: '701', detalles: 'Bono' }),
        rawTx({ id: null, detalles: 'Bono' }),
      ])
      const prepared = connector.prepareTransactions(r.rows)
      expect(r.invalid).toBe(0)
      expect(prepared.withId).toHaveLength(1)
      expect(prepared.withId[0]).toMatchObject({ id_rec: '701', tipo: 'carga', raw_detalles: 'Bono' })
      expect(prepared.withoutId).toHaveLength(1)
      expect(prepared.stats).toMatchObject({ duplicateIds: 1, withoutId: 1, invalid: 0 })
      expect(prepared.coverage).toBe('limited')
    })

    it('does not inherit the Zeus-only bonus rule in Bet30 and preserves existing transaction types', async () => {
      // Reuse the same synthetic env-key configuration as this suite's Zeus fixture.
      const bet30 = new Bet30Connector({ ...CONFIG, name: 'bet30' }, makePool().pool)
      expect(bet30._normalizeOne).toBe(connector._normalizeOne)
      const raw = [rawTx({ detalles: 'BONOS' }), rawTx({ detalles: 'Bono promocional' }),
        rawTx({ detalles: 'Carga de bono' }), rawTx({ detalles: 'Retiro de bono' }),
        rawTx({ detalles: 'Bono indirecto' }), rawTx({ detalles: 'Abono' })]
      const result = await bet30.normalizeWithStats(raw)
      expect(result).toMatchObject({ invalid: 3, excluded: 1 })
      expect(result.rows.map(row => [row.raw_detalles, row.tipo])).toEqual([
        ['Carga de bono', 'carga'], ['Retiro de bono', 'retiro'],
      ])
      expect(bet30.pool.connect).not.toHaveBeenCalled()
    })

    it.each(['bet30', 'future-skin', 'ZEUS', ' zeus '])('requires the exact Zeus platform name for bonuses, even with type zeus: %s', async name => {
      const other = new ZeusConnector({ ...CONFIG, name, type: 'zeus' }, makePool().pool)
      expect(await other.normalizeWithStats([rawTx({ detalles: 'BONO promocional' })]))
        .toEqual({ rows: [], invalid: 1, excluded: 0 })
      expect(other.pool.connect).not.toHaveBeenCalled()
    })

    it.each(['', undefined])('rejects a missing platform name before any bonus classification: %s', name => {
      expect(() => new ZeusConnector({ ...CONFIG, name }, makePool().pool))
        .toThrow('missing required field: "name"')
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

    it('normalizeWithStats separates expected exclusions from invalid rows', async () => {
      const r = await connector.normalizeWithStats([
        rawTx({ id: 'a' }),
        rawTx({ id: 'c', detalles: 'Carga indirecto' }),   // exclusión esperada
        rawTx({ id: 'd', detalles: 'Ajuste' }),            // tipo no reconocido
        rawTx({ id: 'e', username: null }),
        rawTx({ id: 'f', valor: 'abc' }),
        null,
      ])
      expect(r.rows.map(x => x.id_rec)).toEqual(['a'])
      expect(r.excluded).toBe(1)
      expect(r.invalid).toBe(4)
    })
  })

  // ── authenticate ────────────────────────────────────────────────────────────

  describe('authenticate()', () => {
    const LOGIN_CONFIG = {
      ...CONFIG,
      adminUserEnvVar:     'ZEUS_ADMIN_USER',
      adminPasswordEnvVar: 'ZEUS_ADMIN_PASSWORD',
      loginUrl:            'https://login.example.invalid/oauth/v2/token',
      loginClientId:       'cid',
      loginClientSecret:   'synthetic-client-secret',
      loginPanelOrigin:    'https://panel.example.invalid',
    }

    beforeEach(() => {
      process.env.ZEUS_ADMIN_USER     = 'synthetic-user'
      process.env.ZEUS_ADMIN_PASSWORD = 'synthetic phrase with spaces'
    })
    afterEach(() => {
      delete process.env.ZEUS_ADMIN_USER
      delete process.env.ZEUS_ADMIN_PASSWORD
    })

    it('does not read nor echo the error body of a failed login', async () => {
      const text = jest.fn(async () => '{"password":"synthetic phrase with spaces"}')
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text })
      const { pool } = makePool()
      const c   = new ZeusConnector(LOGIN_CONFIG, pool)
      const err = await c.authenticate().catch(e => e)

      expect(err.message).toBe('zeus auto-login failed: HTTP 401')
      expect(err.httpStatus).toBe(401)
      expect(text).not.toHaveBeenCalled()
    })

    it('does not echo the network error message (it may contain the login URL)', async () => {
      global.fetch = jest.fn().mockRejectedValue(Object.assign(
        new TypeError('fetch failed https://login.example.invalid/?password=synthetic phrase with spaces'),
        { cause: { code: 'ECONNREFUSED' } },
      ))
      const { pool } = makePool()
      const err = await new ZeusConnector(LOGIN_CONFIG, pool).authenticate().catch(e => e)
      expect(err.message).toBe('zeus auto-login network error (ECONNREFUSED)')
      expect(err.message).not.toMatch(/synthetic|login\.example/)
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
