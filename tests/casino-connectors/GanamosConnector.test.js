'use strict'

const { GanamosConnector, ALLOWED_AGENT_IDS, buildDayWindows } = require('../../src/casino-connectors/ganamos/GanamosConnector')
const { recordId } = require('../../src/casino-import/excel')
const { createFakeCasinoDb } = require('./helpers/fakeCasinoDb')

// ── Factories ─────────────────────────────────────────────────────────────────

const CONFIG = {
  name:          'ganamos',
  type:          'ganamos',
  baseUrl:       'https://agents.ganamosnet.org',
  baseUrlEnvVar: 'GANAMOS_API_BASE',
  endpoint:      '/api/agent_admin/user',
  timezone:      '-03',
  loginUrl:      null,
  maxPages:      200,
}

const ENV_KEYS = Object.keys(ALLOWED_AGENT_IDS).flatMap(a => [
  `GANAMOS_${a.toUpperCase()}_SESSION_COOKIE`,
  `GANAMOS_${a.toUpperCase()}_USER`,
  `GANAMOS_${a.toUpperCase()}_PASSWORD`,
])

function makePool() {
  const client = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }), release: jest.fn() }
  return {
    pool: { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rowCount: 0 }) },
    client,
  }
}

function makeConnector(config = CONFIG, loginAdapter = null) {
  const { pool } = makePool()
  return new GanamosConnector(config, pool, loginAdapter)
}

// Raw Ganamos item, matches docs/ganamos-export-consola.js field names.
function rawItem(overrides = {}) {
  return {
    id:            'tx-1',
    operation:     0, // deposit
    amount:        500.5,
    created_at:    '2026-08-15T14:00:00', // naive, UTC
    from_user:     'jugador1',
    to_user:       'adminroyal',
    initiator_user: 'adminroyal',
    note:          '',
    ...overrides,
  }
}

function jsonResponse(body, status = 200, setCookies = []) {
  return { ok: status < 400, status, json: async () => body, headers: { getSetCookie: () => setCookies } }
}

function transfersResponse(transfers, status = 0, setCookies = []) {
  return jsonResponse({ status, result: { transfers } }, 200, setCookies)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GanamosConnector', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    delete process.env.GANAMOS_API_BASE
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0 })
  })
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    jest.restoreAllMocks()
  })

  // ── Configuration ────────────────────────────────────────────────────────

  describe('configuration', () => {
    it('constructs successfully with the default (allowed) agentIds', () => {
      expect(() => makeConnector()).not.toThrow()
    })

    it('throws when config.agentIds contains an agent outside the confirmed 6', () => {
      const badConfig = { ...CONFIG, agentIds: { ...ALLOWED_AGENT_IDS, adminfara: '999999' } }
      expect(() => makeConnector(badConfig)).toThrow(/agentIds/)
    })

    it('throws when config.agentIds has a wrong agentId for a known agent name', () => {
      const badConfig = { ...CONFIG, agentIds: { ...ALLOWED_AGENT_IDS, adminbtc: '1' } }
      expect(() => makeConnector(badConfig)).toThrow(/agentIds/)
    })

    it('throws when config.agentIds is missing one of the 6 required agents', () => {
      const { adminimperio, ...rest } = ALLOWED_AGENT_IDS
      expect(() => makeConnector({ ...CONFIG, agentIds: rest })).toThrow(/agentIds/)
    })

    it('throws when config.maxPages is zero, negative or not an integer', () => {
      expect(() => makeConnector({ ...CONFIG, maxPages: 0 })).toThrow(/maxPages/)
      expect(() => makeConnector({ ...CONFIG, maxPages: -1 })).toThrow(/maxPages/)
      expect(() => makeConnector({ ...CONFIG, maxPages: 1.5 })).toThrow(/maxPages/)
    })

    it('fetchTransactions rejects an agent username outside the allowed 6', async () => {
      const connector = makeConnector()
      await expect(connector.fetchTransactions('adminfara', '2026-08-01', '2026-08-01'))
        .rejects.toThrow(/not one of the 6 allowed agents/)
    })
  })

  // ── authenticate() — global, per-agent, never blocking ──────────────────

  describe('authenticate()', () => {
    it('never throws even when NO agent has any credential configured (missing creds fail per-agent later, not here)', async () => {
      const connector = makeConnector()
      await expect(connector.authenticate()).resolves.toBeUndefined()
    })

    it('does not perform any network login eagerly (credentials are checked, not used, at startup)', async () => {
      process.env.GANAMOS_ADMINBTC_USER = 'u'
      process.env.GANAMOS_ADMINBTC_PASSWORD = 'p'
      const loginAdapter = { login: jest.fn() }
      const connector = makeConnector(CONFIG, loginAdapter)
      await connector.authenticate()
      expect(loginAdapter.login).not.toHaveBeenCalled()
    })
  })

  // ── Per-agent login ───────────────────────────────────────────────────────

  describe('_loginAgent() / session establishment', () => {
    it('uses a static GANAMOS_<AGENTE>_SESSION_COOKIE when present (dev shortcut)', async () => {
      process.env.GANAMOS_ADMINROYAL_SESSION_COOKIE = 'session=abc123'
      const connector = makeConnector()
      await connector._loginAgent('adminroyal')
      expect(connector._cookieHeader('adminroyal')).toBe('session=abc123')
    })

    it('parses a multi-cookie static session string into the jar by name', async () => {
      process.env.GANAMOS_ADMINROYAL_SESSION_COOKIE = 'sessionid=abc123; csrftoken=xyz789'
      const connector = makeConnector()
      await connector._loginAgent('adminroyal')
      const jar = connector.agentCookieJars.get('adminroyal')
      expect(jar.get('sessionid')).toBe('abc123')
      expect(jar.get('csrftoken')).toBe('xyz789')
    })

    it('throws a clear per-agent error when neither a session cookie nor user/password is configured', async () => {
      const connector = makeConnector()
      await expect(connector._loginAgent('adminroyal')).rejects.toThrow(/missing credentials for agent "adminroyal"/)
    })

    it('throws when credentials exist but no loginAdapter is injected (real login not captured yet)', async () => {
      process.env.GANAMOS_ADMINROYAL_USER = 'u'
      process.env.GANAMOS_ADMINROYAL_PASSWORD = 'p'
      const connector = makeConnector()
      await expect(connector._loginAgent('adminroyal')).rejects.toThrow(/no login endpoint is implemented/)
    })

    it('logs in via an injected loginAdapter, passing agente/loginUrl/credentials', async () => {
      process.env.GANAMOS_ADMINROYAL_USER = 'the-user'
      process.env.GANAMOS_ADMINROYAL_PASSWORD = 'the-pass'
      const loginAdapter = { login: jest.fn().mockResolvedValue({ cookie: 'session=fresh' }) }
      const connector = makeConnector(CONFIG, loginAdapter)
      await connector._loginAgent('adminroyal')
      expect(connector._cookieHeader('adminroyal')).toBe('session=fresh')
      expect(loginAdapter.login).toHaveBeenCalledWith({
        agente: 'adminroyal',
        loginUrl: null,
        credentials: { user: 'the-user', password: 'the-pass' },
      })
    })

    it('throws if the injected adapter resolves without a cookie', async () => {
      process.env.GANAMOS_ADMINROYAL_USER = 'u'
      process.env.GANAMOS_ADMINROYAL_PASSWORD = 'p'
      const loginAdapter = { login: jest.fn().mockResolvedValue({}) }
      const connector = makeConnector(CONFIG, loginAdapter)
      await expect(connector._loginAgent('adminroyal')).rejects.toThrow(/without a cookie/)
    })

    it('wraps a loginAdapter rejection in a generic message — never propagates the raw error (which may echo credentials/cookies)', async () => {
      process.env.GANAMOS_ADMINROYAL_USER = 'u'
      process.env.GANAMOS_ADMINROYAL_PASSWORD = 'p'
      const loginAdapter = { login: jest.fn().mockRejectedValue(new Error('HTTP 401: bad password=the-pass for user=u')) }
      const connector = makeConnector(CONFIG, loginAdapter)
      let thrown
      try {
        await connector._loginAgent('adminroyal')
      } catch (e) { thrown = e }
      expect(thrown).toBeDefined()
      expect(thrown.message).not.toContain('the-pass')
      expect(thrown.message).toMatch(/login adapter failed for agent "adminroyal"/)
    })

    it('never logs the cookie value or credentials', async () => {
      process.env.GANAMOS_ADMINROYAL_SESSION_COOKIE = 'session=super-secret-value'
      const connector = makeConnector()
      const logSpy = jest.spyOn(connector.log, 'info')
      await connector._loginAgent('adminroyal')
      for (const call of logSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('super-secret-value')
      }
    })
  })

  // ── Day windowing (always 24h) ───────────────────────────────────────────

  describe('buildDayWindows()', () => {
    it('expands a range into one entry per calendar day, inclusive both ends', () => {
      expect(buildDayWindows('2026-08-01', '2026-08-03')).toEqual(['2026-08-01', '2026-08-02', '2026-08-03'])
    })

    it('returns a single day for desde === hasta', () => {
      expect(buildDayWindows('2026-08-01', '2026-08-01')).toEqual(['2026-08-01'])
    })

    it('throws when desde is after hasta', () => {
      expect(() => buildDayWindows('2026-08-05', '2026-08-01')).toThrow(/invalid date range/)
    })

    it('throws on a desde that is not a real calendar date (e.g. Feb 30)', () => {
      expect(() => buildDayWindows('2026-02-30', '2026-03-01')).toThrow(/invalid desde date/)
    })

    it('throws on a hasta that is not a real calendar date', () => {
      expect(() => buildDayWindows('2026-08-01', '2026-13-01')).toThrow(/invalid hasta date/)
    })

    it('throws on a malformed (non YYYY-MM-DD) date string instead of comparing it as an opaque string', () => {
      expect(() => buildDayWindows('08/01/2026', '2026-08-01')).toThrow(/invalid desde date/)
    })
  })

  // ── fetchTransactions() — params, pagination, cap, body errors ─────────

  describe('fetchTransactions()', () => {
    beforeEach(() => {
      process.env.GANAMOS_ADMINROYAL_SESSION_COOKIE = 'session=abc'
    })

    it('sends the exact fixed params from docs/ganamos-export-consola.js for each day', async () => {
      const connector = makeConnector()
      global.fetch = jest.fn().mockResolvedValueOnce(transfersResponse([]))
      await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01')

      const url = new URL(global.fetch.mock.calls[0][0])
      expect(url.pathname).toBe('/api/agent_admin/user/24044323/payment/history/')
      expect(url.searchParams.get('date_from')).toBe('2026-08-01T00:00:00')
      expect(url.searchParams.get('date_to')).toBe('2026-08-02T00:00:00')
      expect(url.searchParams.get('username')).toBe('')
      expect(url.searchParams.get('role')).toBe('0')
      expect(url.searchParams.get('is_direct_structure')).toBe('false')
      expect(url.searchParams.get('is_higher_transaction_only')).toBe('false')
      expect(url.searchParams.get('is_deposit_transfers')).toBe('true')
      expect(url.searchParams.get('is_withdrawal_transfers')).toBe('true')
      expect(url.searchParams.get('is_bonus_deposits')).toBe('false')
      expect(url.searchParams.get('transfers_only')).toBe('true')
      expect(url.searchParams.get('page')).toBe('0')
      expect(url.searchParams.get('count')).toBe('500')
    })

    it('sends the session cookie as the Cookie header, never a Bearer token', async () => {
      const connector = makeConnector()
      global.fetch = jest.fn().mockResolvedValueOnce(transfersResponse([]))
      await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01')
      const headers = global.fetch.mock.calls[0][1].headers
      expect(headers['Cookie']).toBe('session=abc')
      expect(headers['Authorization']).toBeUndefined()
    })

    it('issues one request window PER DAY, never a multi-day range', async () => {
      const connector = makeConnector()
      global.fetch = jest.fn().mockResolvedValue(transfersResponse([]))
      await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-03')
      expect(global.fetch).toHaveBeenCalledTimes(3)
      const dates = global.fetch.mock.calls.map(c => new URL(c[0]).searchParams.get('date_from'))
      expect(dates).toEqual(['2026-08-01T00:00:00', '2026-08-02T00:00:00', '2026-08-03T00:00:00'])
    })

    it('paginates within a day and stops once a batch is smaller than count=500', async () => {
      const connector = makeConnector()
      const fullPage  = Array.from({ length: 500 }, (_, i) => rawItem({ id: `p1-${i}` }))
      const lastPage  = Array.from({ length: 3 }, (_, i) => rawItem({ id: `p2-${i}` }))
      global.fetch = jest.fn()
        .mockResolvedValueOnce(transfersResponse(fullPage))
        .mockResolvedValueOnce(transfersResponse(lastPage))
      const result = await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01')
      expect(result).toHaveLength(503)
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('throws instead of a partial success when maxPages is exceeded for a day', async () => {
      const connector = makeConnector({ ...CONFIG, maxPages: 2 })
      const fullPage = Array.from({ length: 500 }, (_, i) => rawItem({ id: `x-${i}` }))
      global.fetch = jest.fn().mockResolvedValue(transfersResponse(fullPage))
      await expect(connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01'))
        .rejects.toThrow(/exceeded maxPages/)
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('throws on body.status !== 0 even when HTTP status is 200, without leaking the raw error_message', async () => {
      const connector = makeConnector()
      global.fetch = jest.fn().mockResolvedValueOnce(
        jsonResponse({ status: 7, error_message: 'session=leaked-cookie-value' })
      )
      let thrown
      try {
        await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01')
      } catch (e) { thrown = e }
      expect(thrown).toBeDefined()
      expect(thrown.message).toMatch(/application error/)
      expect(thrown.message).not.toContain('leaked-cookie-value')
    })

    it('throws on an unexpected response shape instead of treating it as an empty page', async () => {
      const connector = makeConnector()
      global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ unexpected: 'shape' }))
      await expect(connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01'))
        .rejects.toThrow(/unexpected response shape/)
    })

    it('throws when result.transfers is missing even though status === 0', async () => {
      const connector = makeConnector()
      global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ status: 0, result: {} }))
      await expect(connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01'))
        .rejects.toThrow(/missing result.transfers/)
    })

    it('throws if the API ignores count and returns more rows than requested (paginate-safety guard, same as Argenbet)', async () => {
      const connector = makeConnector()
      const oversized = Array.from({ length: 501 }, (_, i) => rawItem({ id: `o-${i}` }))
      global.fetch = jest.fn().mockResolvedValueOnce(transfersResponse(oversized))
      await expect(connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01'))
        .rejects.toThrow(/more than the requested count/)
    })
  })

  // ── Cookie jar rotation via Set-Cookie ───────────────────────────────────

  describe('cookie jar — Set-Cookie rotation', () => {
    it('picks up a rotated session cookie from a Set-Cookie response header and uses it on the next page', async () => {
      process.env.GANAMOS_ADMINROYAL_SESSION_COOKIE = 'sessionid=old-value'
      const connector = makeConnector()
      const fullPage = Array.from({ length: 500 }, (_, i) => rawItem({ id: `p1-${i}` }))
      global.fetch = jest.fn()
        .mockResolvedValueOnce(transfersResponse(fullPage, 0, ['sessionid=new-value; Path=/; HttpOnly']))
        .mockResolvedValueOnce(transfersResponse([]))

      await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01')

      expect(global.fetch.mock.calls[0][1].headers['Cookie']).toBe('sessionid=old-value')
      expect(global.fetch.mock.calls[1][1].headers['Cookie']).toBe('sessionid=new-value')
    })

    it('merges Set-Cookie by name, keeping other cookies the jar already held', async () => {
      process.env.GANAMOS_ADMINROYAL_SESSION_COOKIE = 'sessionid=old-value; csrftoken=stays-the-same'
      const connector = makeConnector()
      const fullPage = Array.from({ length: 500 }, (_, i) => rawItem({ id: `p1-${i}` }))
      global.fetch = jest.fn()
        .mockResolvedValueOnce(transfersResponse(fullPage, 0, ['sessionid=new-value; Path=/']))
        .mockResolvedValueOnce(transfersResponse([]))

      await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01')

      const secondCookie = global.fetch.mock.calls[1][1].headers['Cookie']
      expect(secondCookie).toContain('sessionid=new-value')
      expect(secondCookie).toContain('csrftoken=stays-the-same')
    })

    it('removes a cookie whose Set-Cookie carries Max-Age=0 (server-signaled deletion)', async () => {
      process.env.GANAMOS_ADMINROYAL_SESSION_COOKIE = 'sessionid=old-value; extra=gone-soon'
      const connector = makeConnector()
      const fullPage = Array.from({ length: 500 }, (_, i) => rawItem({ id: `p1-${i}` }))
      global.fetch = jest.fn()
        .mockResolvedValueOnce(transfersResponse(fullPage, 0, ['extra=; Max-Age=0']))
        .mockResolvedValueOnce(transfersResponse([]))

      await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01')

      const secondCookie = global.fetch.mock.calls[1][1].headers['Cookie']
      expect(secondCookie).not.toContain('extra=')
      expect(secondCookie).toContain('sessionid=old-value')
    })

    it('does not corrupt the jar on a Set-Cookie whose Expires attribute contains a comma', async () => {
      process.env.GANAMOS_ADMINROYAL_SESSION_COOKIE = 'sessionid=old-value'
      const connector = makeConnector()
      const fullPage = Array.from({ length: 500 }, (_, i) => rawItem({ id: `p1-${i}` }))
      global.fetch = jest.fn()
        .mockResolvedValueOnce(transfersResponse(fullPage, 0, ['sessionid=new-value; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/']))
        .mockResolvedValueOnce(transfersResponse([]))

      await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01')
      expect(global.fetch.mock.calls[1][1].headers['Cookie']).toBe('sessionid=new-value')
    })

    it('a rotated cookie for one agent never leaks into another agent\'s jar', async () => {
      process.env.GANAMOS_ADMINROYAL_SESSION_COOKIE = 'sessionid=royal-old'
      process.env.GANAMOS_ADMINZEUS_SESSION_COOKIE   = 'sessionid=zeus-old'
      const connector = makeConnector()
      await connector._loginAgent('adminzeus') // establish adminzeus's jar too, so we can prove it's untouched
      const fullPage = Array.from({ length: 500 }, (_, i) => rawItem({ id: `p1-${i}` }))
      global.fetch = jest.fn()
        .mockResolvedValueOnce(transfersResponse(fullPage, 0, ['sessionid=royal-new']))
        .mockResolvedValueOnce(transfersResponse([]))

      await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01')
      expect(connector._cookieHeader('adminzeus')).toBe('sessionid=zeus-old')
    })
  })

  // ── normalizeTransactions() — operation / identity rules ────────────────

  describe('normalizeTransactions()', () => {
    it('operation === 0 is a deposit (carga)', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ operation: 0 }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.tipo).toBe('carga')
    })

    it('any non-zero operation is a withdrawal (retiro)', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ operation: 3 }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.tipo).toBe('retiro')
    })

    it('player is the side that is NOT the requesting agent, when agent is to_user', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ from_user: 'jugador9', to_user: 'adminroyal' }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.username).toBe('jugador9')
    })

    it('player is the side that is NOT the requesting agent, when agent is from_user', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ from_user: 'adminroyal', to_user: 'jugador9' }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.username).toBe('jugador9')
    })

    it('throws when NEITHER side is the requesting agent — malformed for this agent session', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ from_user: 'jugadorA', to_user: 'jugadorB' }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/ambiguous\/missing agent side/)
    })

    it('throws when BOTH sides are the requesting agent — malformed', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ from_user: 'adminroyal', to_user: 'adminroyal' }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/ambiguous\/missing agent side/)
    })

    it('discards (does not throw) a transfer between two known agents — out of scope, same exclusion as the Excel importer', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ from_user: 'adminroyal', to_user: 'adminzeus' }), __agentUsername: 'adminroyal' }
      expect(await connector.normalizeTransactions([raw])).toEqual([])
    })

    it('throws on a transaction missing id', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ id: undefined }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/missing or non-string\/number id/)
    })

    it('throws on a whitespace-only id instead of hashing it into a bogus source_id', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ id: '   ' }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/missing id/)
    })

    it('throws on an id that is an object instead of stringifying it into "[object Object]"', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ id: { nested: true } }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/missing or non-string\/number id/)
    })

    it('throws on a numeric id outside the safe integer range (precision already lost)', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ id: 9007199254740993 }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/outside safe integer range/)
    })

    it('accepts a numeric id within the safe integer range', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ id: 918273 }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.source_id).toBe('918273')
    })

    it('throws on a transaction missing from_user/to_user', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ to_user: '' }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/missing from_user\/to_user/)
    })

    it('throws when from_user/to_user is not a string (never coerces an object into "[object Object]")', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ to_user: { id: 5 } }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/missing from_user\/to_user/)
    })

    it('throws on a transaction missing operation', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ operation: undefined }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/missing operation/)
    })

    it('throws on a transaction missing created_at', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ created_at: undefined }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/missing created_at/)
    })

    it('throws instead of silently treating a null/empty amount as zero', async () => {
      const connector = makeConnector()
      const rawNull  = { ...rawItem({ amount: null }), __agentUsername: 'adminroyal' }
      const rawEmpty = { ...rawItem({ amount: '' }),   __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([rawNull])).rejects.toThrow(/has no amount/)
      await expect(connector.normalizeTransactions([rawEmpty])).rejects.toThrow(/has no amount/)
    })

    it('preserves cents exactly without rounding', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ amount: 23372265.55 }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.monto).toBe('23372265.55')
    })

    it('rejects a boolean amount instead of coercing true -> 1', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ amount: true }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/non-numeric amount/)
    })

    it('rejects a whitespace-only amount string instead of coercing it to 0', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ amount: '   ' }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/non-numeric amount/)
    })

    it('rejects exponent notation and thousands separators', async () => {
      const connector = makeConnector()
      const rawExp = { ...rawItem({ amount: '1e3' }), __agentUsername: 'adminroyal' }
      const rawSep = { ...rawItem({ amount: '1,000.50' }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([rawExp])).rejects.toThrow(/non-numeric amount/)
      await expect(connector.normalizeTransactions([rawSep])).rejects.toThrow(/non-numeric amount/)
    })

    it('accepts a valid signed decimal string with exactly 2 decimals', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ amount: '-500.25' }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.monto).toBe('500.25')
    })
  })

  // ── created_at: naive but UTC (near-midnight boundary) ───────────────────

  describe('created_at handling (naive, UTC per plan)', () => {
    it('appends Z to a naive created_at and derives the correct Argentina local fecha', async () => {
      const connector = makeConnector()
      // naive 02:30 == 02:30 UTC == 2026-08-14 23:30 ART (day before)
      const raw = { ...rawItem({ created_at: '2026-08-15T02:30:00' }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.fecha_hora_utc).toBe('2026-08-15T02:30:00.000Z')
      expect(tx.fecha).toBe('2026-08-14')
    })

    it('a naive created_at exactly at 03:00 lands on the same UTC calendar day, local midnight ART', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ created_at: '2026-08-15T03:00:00' }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.fecha_hora_utc).toBe('2026-08-15T03:00:00.000Z')
      expect(tx.fecha).toBe('2026-08-15')
    })

    it('does not depend on the host TZ: an already-zoned created_at is left as-is', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ created_at: '2026-08-15T02:30:00-03:00' }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.fecha_hora_utc).toBe('2026-08-15T05:30:00.000Z')
    })

    it('throws on an unparsable created_at', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ created_at: 'not-a-date' }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/unparsable created_at/)
    })
  })

  // ── Identity compatible with the Excel importer ──────────────────────────

  describe('identity matches src/casino-import/excel.js exactly', () => {
    it('a numeric API id produces the same id_rec/source_id the importer would compute', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ id: 918273 }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.source_id).toBe('918273')
      expect(tx.id_rec).toBe(recordId('918273'))
      expect(tx.id_rec).toBe('918273')
    })

    it('a non-numeric id hashes to the same negative id_rec the importer would compute', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ id: 'gm-abc-123' }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.id_rec).toBe(recordId('gm-abc-123'))
      expect(BigInt(tx.id_rec) < 0n).toBe(true)
    })

    it('the same transaction ingested here and shaped like the Excel importer would produce exactly one row', async () => {
      const db = createFakeCasinoDb()
      const connector = new GanamosConnector(CONFIG, db.pool)
      const raw = { ...rawItem({ id: 55501 }), __agentUsername: 'adminroyal' }
      const [apiTx] = await connector.normalizeTransactions([raw])
      await connector.insertTransactions('adminroyal', [apiTx])

      const excelShapedTx = {
        id_rec: recordId('55501'), source_id: '55501', username: apiTx.username, agente: apiTx.agente,
        tipo: apiTx.tipo, monto: apiTx.monto, fecha: apiTx.fecha, fecha_hora_utc: apiTx.fecha_hora_utc,
        raw_detalles: apiTx.raw_detalles,
      }
      await connector.insertTransactions('adminroyal', [excelShapedTx])
      expect(db.transactions).toHaveLength(1)
    })
  })

  // ── Cookie isolation between agents, scoped reauth on 401/403 ────────────

  describe('cookie isolation and scoped reauth', () => {
    it('uses a different cookie per agent — no cross-contamination', async () => {
      process.env.GANAMOS_ADMINROYAL_SESSION_COOKIE = 'session=royal-cookie'
      process.env.GANAMOS_ADMINZEUS_SESSION_COOKIE   = 'session=zeus-cookie'
      const connector = makeConnector()
      global.fetch = jest.fn().mockResolvedValue(transfersResponse([]))

      await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01')
      await connector.fetchTransactions('adminzeus', '2026-08-01', '2026-08-01')

      const cookiesUsed = global.fetch.mock.calls.map(c => c[1].headers['Cookie'])
      expect(cookiesUsed[0]).toBe('session=royal-cookie')
      expect(cookiesUsed[1]).toBe('session=zeus-cookie')
    })

    it('two agents syncing concurrently through the same connector instance never mix cookies (no shared "currentAgent" state)', async () => {
      process.env.GANAMOS_ADMINROYAL_SESSION_COOKIE = 'session=royal-cookie'
      process.env.GANAMOS_ADMINZEUS_SESSION_COOKIE   = 'session=zeus-cookie'
      const connector = makeConnector()

      global.fetch = jest.fn().mockImplementation((url) => {
        const isRoyal = url.includes('/24044323/')
        return Promise.resolve(transfersResponse([
          rawItem({ id: isRoyal ? 'r-1' : 'z-1', from_user: 'jugadorX', to_user: isRoyal ? 'adminroyal' : 'adminzeus' }),
        ]))
      })

      const [royalResult, zeusResult] = await Promise.all([
        connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01'),
        connector.fetchTransactions('adminzeus', '2026-08-01', '2026-08-01'),
      ])

      const royalCall = global.fetch.mock.calls.find(c => c[0].includes('/24044323/'))
      const zeusCall  = global.fetch.mock.calls.find(c => c[0].includes('/23851856/'))
      expect(royalCall[1].headers['Cookie']).toBe('session=royal-cookie')
      expect(zeusCall[1].headers['Cookie']).toBe('session=zeus-cookie')
      expect(royalResult).toHaveLength(1)
      expect(zeusResult).toHaveLength(1)
    })

    it('re-authenticates only the agent that got the 401, not the other agent — via an injected loginAdapter', async () => {
      process.env.GANAMOS_ADMINROYAL_USER = 'royal-user'
      process.env.GANAMOS_ADMINROYAL_PASSWORD = 'royal-pass'
      process.env.GANAMOS_ADMINZEUS_SESSION_COOKIE = 'session=zeus-cookie'

      const loginAdapter = { login: jest.fn().mockResolvedValue({ cookie: 'session=royal-fresh' }) }
      const connector = makeConnector(CONFIG, loginAdapter)

      global.fetch = jest.fn()
        .mockResolvedValueOnce(jsonResponse({}, 401))       // adminroyal first attempt: 401
        .mockResolvedValueOnce(transfersResponse([]))        // adminroyal retry after reauth: ok
        .mockResolvedValueOnce(transfersResponse([]))        // adminzeus: unaffected, single call, ok

      await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01')
      await connector.fetchTransactions('adminzeus', '2026-08-01', '2026-08-01')

      // Called twice for adminroyal (lazy initial login + the 401-triggered
      // reauth) — never for adminzeus, which used its static session cookie.
      expect(loginAdapter.login).toHaveBeenCalledTimes(2)
      for (const call of loginAdapter.login.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ agente: 'adminroyal' }))
      }
      expect(connector._cookieHeader('adminzeus')).toBe('session=zeus-cookie') // untouched
      expect(connector._cookieHeader('adminroyal')).toBe('session=royal-fresh')
    })

    it('fails visibly (throws) if 401 persists for an agent after reauth, without touching other agents', async () => {
      process.env.GANAMOS_ADMINROYAL_SESSION_COOKIE = 'session=stale'
      const connector = makeConnector()
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({}, 401))

      await expect(connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-01')).rejects.toThrow()
    })
  })

  // ── Missing-agent isolation via the base sync pipeline ───────────────────

  describe('one agent missing credentials does not block others (via syncAgent, the same shape sync-casino-players-live.js loops over)', () => {
    it('an agent with no credentials fails its own syncAgent() call while a properly configured agent still succeeds', async () => {
      process.env.GANAMOS_ADMINROYAL_SESSION_COOKIE = 'session=abc'
      const db = createFakeCasinoDb()
      const connector = new GanamosConnector(CONFIG, db.pool)
      await connector.authenticate() // must not throw despite 5 agents missing creds

      global.fetch = jest.fn().mockResolvedValue(transfersResponse([]))

      await expect(connector.syncAgent('adminzeus', '2026-08-01', '2026-08-01')).rejects.toThrow(/missing credentials/)
      await expect(connector.syncAgent('adminroyal', '2026-08-01', '2026-08-01')).resolves.toBeDefined()
    })
  })

  // ── Stale-sync warning (fase 3 primitive, fase 4 wires it to real data) ──

  describe('checkStaleSync()', () => {
    it('warns when the last successful sync is older than 7 days', () => {
      const connector = makeConnector()
      const logSpy = jest.spyOn(connector.log, 'warn')
      const now = new Date('2026-09-21T00:00:00Z')
      connector.checkStaleSync('adminroyal', '2026-09-10T00:00:00Z', now) // 11 days
      expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ agent: 'adminroyal' }), expect.stringMatching(/older than 7 days/))
    })

    it('does not warn when the last successful sync is within 7 days', () => {
      const connector = makeConnector()
      const logSpy = jest.spyOn(connector.log, 'warn')
      const now = new Date('2026-09-21T00:00:00Z')
      connector.checkStaleSync('adminroyal', '2026-09-16T00:00:00Z', now) // 5 days
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('does nothing when there is no prior successful sync recorded', () => {
      const connector = makeConnector()
      const logSpy = jest.spyOn(connector.log, 'warn')
      connector.checkStaleSync('adminroyal', null, new Date())
      expect(logSpy).not.toHaveBeenCalled()
    })
  })
})
