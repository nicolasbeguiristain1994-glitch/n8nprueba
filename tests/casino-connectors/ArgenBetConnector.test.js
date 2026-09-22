'use strict'

const { ArgenBetConnector, ALLOWED_AGENT_IDS } = require('../../src/casino-connectors/argenbet/ArgenBetConnector')
const { recordId } = require('../../src/casino-import/excel')
const { createFakeCasinoDb } = require('./helpers/fakeCasinoDb')

// ── Factories ─────────────────────────────────────────────────────────────────

const CONFIG = {
  name:               'argenbet',
  type:               'argenbet',
  baseUrl:            'https://admin.argenbet.net',
  baseUrlEnvVar:      'ARGENBET_API_BASE',
  playerTokenEnvVar:  'ARGENBET_PLAYER_TOKEN',
  adminUserEnvVar:    'ARGENBET_ADMIN_USER',
  adminPasswordEnvVar: 'ARGENBET_ADMIN_PASSWORD',
  endpoint:           '/api/backoffice/v1/account-transfers/player',
  timezone:           '-03',
  maxPages:           500,
}

function makePool() {
  const client = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }), release: jest.fn() }
  return {
    pool: { connect: jest.fn().mockResolvedValue(client), query: jest.fn().mockResolvedValue({ rowCount: 0 }) },
    client,
  }
}

function makeConnector(config = CONFIG, loginAdapter = null) {
  const { pool } = makePool()
  return new ArgenBetConnector(config, pool, loginAdapter)
}

// Raw ArgenBet item with sensible INCOME defaults (matches
// docs/argenbet-export-consola.js's documented field names).
function rawItem(overrides = {}) {
  return {
    id:             'tx-1',
    operation:      'INCOME',
    amount:         500.5,
    createdAt:      '2026-08-15T14:00:00.000Z',
    toUserId:       999,
    toUsername:     'jugador1',
    toUserRole:     'player',
    fromUserId:     637255,
    fromUsername:   'adminroyal',
    fromUserRole:   'agent',
    creatorUsername: 'adminroyal',
    ...overrides,
  }
}

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ArgenBetConnector', () => {

  beforeEach(() => {
    process.env.ARGENBET_PLAYER_TOKEN = 'test-static-token'
    delete process.env.ARGENBET_API_BASE
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0 })
  })
  afterEach(() => {
    delete process.env.ARGENBET_PLAYER_TOKEN
    delete process.env.ARGENBET_ADMIN_USER
    delete process.env.ARGENBET_ADMIN_PASSWORD
    jest.restoreAllMocks()
  })

  // ── Configuration ────────────────────────────────────────────────────────

  describe('configuration', () => {
    it('constructs successfully with the default (allowed) agentIds', () => {
      expect(() => makeConnector()).not.toThrow()
    })

    it('throws when ARGENBET_PLAYER_TOKEN is missing', () => {
      delete process.env.ARGENBET_PLAYER_TOKEN
      expect(() => makeConnector()).toThrow('ARGENBET_PLAYER_TOKEN')
    })

    it('throws when config.agentIds contains an agent outside the confirmed 3', () => {
      const badConfig = { ...CONFIG, agentIds: { ...ALLOWED_AGENT_IDS, adminfara: '999999' } }
      expect(() => makeConnector(badConfig)).toThrow(/agentIds/)
    })

    it('throws when config.agentIds has a wrong agentUserId for a known agent name', () => {
      const badConfig = { ...CONFIG, agentIds: { adminbtc: '1', adminzeus: '637252', adminroyal: '637255' } }
      expect(() => makeConnector(badConfig)).toThrow(/agentIds/)
    })

    it('throws when config.agentIds is missing one of the 3 required agents', () => {
      const badConfig = { ...CONFIG, agentIds: { adminbtc: '637249', adminzeus: '637252' } }
      expect(() => makeConnector(badConfig)).toThrow(/agentIds/)
    })

    it('fetchTransactions rejects an agent username outside the allowed 3', async () => {
      const connector = makeConnector()
      await expect(connector.fetchTransactions('adminfara', '2026-08-01', '2026-08-02'))
        .rejects.toThrow(/not one of the 3 allowed agents/)
    })

    it('throws when config.maxPages is zero, negative or not an integer', () => {
      expect(() => makeConnector({ ...CONFIG, maxPages: 0 })).toThrow(/maxPages/)
      expect(() => makeConnector({ ...CONFIG, maxPages: -1 })).toThrow(/maxPages/)
      expect(() => makeConnector({ ...CONFIG, maxPages: 1.5 })).toThrow(/maxPages/)
    })

    it('constructs successfully without ARGENBET_PLAYER_TOKEN when a login adapter is injected', () => {
      delete process.env.ARGENBET_PLAYER_TOKEN
      const loginAdapter = { login: jest.fn() }
      expect(() => makeConnector(CONFIG, loginAdapter)).not.toThrow()
    })
  })

  // ── authenticate() / re-auth on 401 ─────────────────────────────────────

  describe('authenticate()', () => {
    // scripts/sync-casino-players-live.js calls `await connector.authenticate()`
    // unconditionally, for every platform, once at startup — BEFORE the first
    // request. With only a static ARGENBET_PLAYER_TOKEN configured (no
    // adapter), authenticate() must resolve cleanly here (matching
    // ZeusConnector's own no-op-when-no-auto-login-configured behavior) —
    // throwing would make the static-token-only mode the brief explicitly
    // asks for completely unusable.
    it('is a safe no-op when no login adapter is configured (never throws at startup)', async () => {
      const connector = makeConnector()
      await expect(connector.authenticate()).resolves.toBeUndefined()
      expect(connector.playerToken).toBe('test-static-token') // untouched
    })

    it('refreshes the token via an injected login adapter, passing loginUrl + credentials from env', async () => {
      process.env.ARGENBET_ADMIN_USER     = 'admin-user'
      process.env.ARGENBET_ADMIN_PASSWORD = 'admin-pass'
      const loginAdapter = { login: jest.fn().mockResolvedValue({ token: 'fresh-token' }) }
      const connector = makeConnector(CONFIG, loginAdapter)
      await connector.authenticate()
      expect(connector.playerToken).toBe('fresh-token')
      expect(loginAdapter.login).toHaveBeenCalledTimes(1)
      expect(loginAdapter.login).toHaveBeenCalledWith({
        loginUrl:    null,
        credentials: { user: 'admin-user', password: 'admin-pass' },
      })
    })

    it('throws if the injected login adapter resolves without a token', async () => {
      process.env.ARGENBET_ADMIN_USER     = 'admin-user'
      process.env.ARGENBET_ADMIN_PASSWORD = 'admin-pass'
      const loginAdapter = { login: jest.fn().mockResolvedValue({}) }
      const connector = makeConnector(CONFIG, loginAdapter)
      await expect(connector.authenticate()).rejects.toThrow(/without a token/)
    })

    it('throws a sanitized error (never the adapter\'s raw message) when the login adapter rejects', async () => {
      process.env.ARGENBET_ADMIN_USER     = 'admin-user'
      process.env.ARGENBET_ADMIN_PASSWORD = 'super-secret-pass'
      const loginAdapter = { login: jest.fn().mockRejectedValue(new Error('bad credentials: super-secret-pass')) }
      const connector = makeConnector(CONFIG, loginAdapter)
      await expect(connector.authenticate()).rejects.toThrow(/login adapter failed/)
      await expect(connector.authenticate()).rejects.not.toThrow(/super-secret-pass/)
    })

    it('throws when a login adapter is configured but ARGENBET_ADMIN_USER/PASSWORD are missing', async () => {
      const loginAdapter = { login: jest.fn() }
      const connector = makeConnector(CONFIG, loginAdapter)
      await expect(connector.authenticate()).rejects.toThrow(/ARGENBET_ADMIN_USER/)
      expect(loginAdapter.login).not.toHaveBeenCalled()
    })
  })

  describe('main sequence: constructor -> authenticate() -> syncAgent(), static token only, no adapter', () => {
    // Reproduces exactly what scripts/sync-casino-players-live.js's main()
    // does for every platform, end to end, to guard against the startup
    // regression above ever coming back.
    it('runs the full pipeline without ever throwing from the unconditional startup authenticate() call', async () => {
      const db = createFakeCasinoDb()
      const connector = new ArgenBetConnector(CONFIG, db.pool) // no loginAdapter, mirrors production today

      await connector.authenticate() // must not throw

      global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ items: [rawItem({ id: 424242 })] }))

      const result = await connector.syncAgent('adminroyal', '2026-08-01', '2026-08-02')
      expect(result.insertedTxCount).toBe(1)
      expect(db.transactions).toHaveLength(1)
    })
  })

  describe('401 handling end-to-end (via fetchTransactions -> _fetchWithRetry)', () => {
    it('retries once after a successful reauth via the injected adapter, then succeeds', async () => {
      process.env.ARGENBET_ADMIN_USER     = 'admin-user'
      process.env.ARGENBET_ADMIN_PASSWORD = 'admin-pass'
      const loginAdapter = { login: jest.fn().mockResolvedValue({ token: 'fresh-token' }) }
      const connector = makeConnector(CONFIG, loginAdapter)

      global.fetch = jest.fn()
        .mockResolvedValueOnce(jsonResponse({}, 401))
        .mockResolvedValueOnce(jsonResponse({ items: [] }))

      const result = await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-02')
      expect(result).toEqual([])
      expect(loginAdapter.login).toHaveBeenCalledTimes(1)
      expect(global.fetch).toHaveBeenCalledTimes(2)
      // The retried request must use the refreshed token, not the stale one.
      expect(global.fetch.mock.calls[1][1].headers['Authorization']).toBe('Bearer fresh-token')
    })

    it('fails visibly (throws) if 401 persists even after reauth — never an infinite loop, never a silent empty success', async () => {
      process.env.ARGENBET_ADMIN_USER     = 'admin-user'
      process.env.ARGENBET_ADMIN_PASSWORD = 'admin-pass'
      const loginAdapter = { login: jest.fn().mockResolvedValue({ token: 'still-bad-token' }) }
      const connector = makeConnector(CONFIG, loginAdapter)

      global.fetch = jest.fn().mockResolvedValue(jsonResponse({}, 401))

      await expect(connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-02')).rejects.toThrow()
      expect(global.fetch).toHaveBeenCalledTimes(2) // 1 original + 1 post-reauth retry, then hard stop
    })

    it('fails visibly when only a static (unrefreshable) token is configured and the API returns 401', async () => {
      const connector = makeConnector() // no loginAdapter injected
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({}, 401))

      await expect(connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-02')).rejects.toThrow()
    })
  })

  // ── Pagination ───────────────────────────────────────────────────────────

  describe('pagination', () => {
    it('follows offset pagination across multiple full (50-row) pages and stops on a smaller final batch', async () => {
      const connector = makeConnector()
      const page1 = Array.from({ length: 50 }, (_, i) => rawItem({ id: `p1-${i}` }))
      const page2 = Array.from({ length: 50 }, (_, i) => rawItem({ id: `p2-${i}` }))
      const page3 = Array.from({ length: 12 }, (_, i) => rawItem({ id: `p3-${i}` }))

      global.fetch = jest.fn()
        .mockResolvedValueOnce(jsonResponse({ items: page1 }))
        .mockResolvedValueOnce(jsonResponse({ items: page2 }))
        .mockResolvedValueOnce(jsonResponse({ items: page3 }))

      const result = await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-02')

      expect(global.fetch).toHaveBeenCalledTimes(3)
      expect(result).toHaveLength(112)

      // offset must advance by the running total of rows received, limit stays fixed at 50
      const urls = global.fetch.mock.calls.map(c => new URL(c[0]))
      expect(urls[0].searchParams.get('offset')).toBe('0')
      expect(urls[0].searchParams.get('limit')).toBe('50')
      expect(urls[1].searchParams.get('offset')).toBe('50')
      expect(urls[2].searchParams.get('offset')).toBe('100')
    })

    it('stops after a single page smaller than the limit (no extra request)', async () => {
      const connector = makeConnector()
      global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ items: [rawItem()] }))
      const result = await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-02')
      expect(result).toHaveLength(1)
      expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    it('throws instead of returning a partial result when maxPages is exceeded (never a silent partial "success")', async () => {
      const connector = makeConnector({ ...CONFIG, maxPages: 2 })
      const fullPage = Array.from({ length: 50 }, (_, i) => rawItem({ id: `x-${i}` }))
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({ items: fullPage }))

      await expect(connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-02'))
        .rejects.toThrow(/exceeded maxPages/)
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('throws if the API ignores the limit param and returns more rows than requested', async () => {
      const connector = makeConnector()
      const oversizedPage = Array.from({ length: 51 }, (_, i) => rawItem({ id: `y-${i}` }))
      global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ items: oversizedPage }))
      await expect(connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-02'))
        .rejects.toThrow(/more than the requested limit/)
    })

    it('sends operations[]=INCOME and operations[]=OUTCOME on every page', async () => {
      const connector = makeConnector()
      global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ items: [] }))
      await connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-02')
      const url = new URL(global.fetch.mock.calls[0][0])
      expect(url.searchParams.getAll('operations[]')).toEqual(['INCOME', 'OUTCOME'])
    })

    it('throws on an unexpected (non-array-like) response shape instead of silently returning empty', async () => {
      const connector = makeConnector()
      global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ unexpected: 'shape' }))
      await expect(connector.fetchTransactions('adminroyal', '2026-08-01', '2026-08-02'))
        .rejects.toThrow(/unexpected response shape/)
    })
  })

  // ── Role normalization (H10) ─────────────────────────────────────────────

  describe('normalizeTransactions() — player role / INCOME vs OUTCOME', () => {
    it('INCOME: player is on the "to" side', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ operation: 'INCOME' }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.tipo).toBe('carga')
      expect(tx.username).toBe('jugador1')
    })

    it('OUTCOME: player is on the "from" side, NOT toUsername (the bug the plan calls out)', async () => {
      const connector = makeConnector()
      const raw = {
        ...rawItem({
          operation:    'OUTCOME',
          toUserId:     637255,
          toUsername:   'adminroyal',
          toUserRole:   'agent',
          fromUserId:   999,
          fromUsername: 'jugador2',
          fromUserRole: 'player',
        }),
        __agentUsername: 'adminroyal',
      }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.tipo).toBe('retiro')
      expect(tx.username).toBe('jugador2')
      expect(tx.username).not.toBe('adminroyal')
    })

    it('derives agente from the agentUserId that requested the page, not from creatorUsername', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ creatorUsername: 'some-other-name' }), __agentUsername: 'adminzeus' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.agente).toBe('adminzeus')
    })

    it('throws (does not silently discard) on an ambiguous player role (both sides "player") — malformed, not out of scope', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ toUserRole: 'player', fromUserRole: 'player' }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/ambiguous\/missing player role/)
    })

    it('throws on no player role at all (both agent/other) — malformed, not out of scope', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ toUserRole: 'agent', fromUserRole: 'agent' }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/ambiguous\/missing player role/)
    })

    it('discards a transaction with an unknown operation (e.g. a bonus) instead of guessing — this one IS out of scope', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ operation: 'BONUS' }), __agentUsername: 'adminroyal' }
      expect(await connector.normalizeTransactions([raw])).toEqual([])
    })

    it('throws on a transaction with no stable id — H8 confirmed every real row has one, so this is malformed, not out of scope', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ id: undefined, transferId: undefined, transactionId: undefined, uuid: undefined }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/no stable id/)
    })

    it('throws on a transaction with a missing/blank player username', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ toUsername: '  ' }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/missing the player username/)
    })

    it('throws on a transaction with a missing createdAt', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ createdAt: undefined }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/missing createdAt/)
    })
  })

  // ── Decimal precision (D3) ───────────────────────────────────────────────

  describe('decimal precision', () => {
    it('preserves cents exactly, without rounding, as a fixed 2-decimal value', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ amount: 14920991.67 }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.monto).toBe('14920991.67')
    })

    it('takes the absolute value regardless of sign', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ amount: -250.10 }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.monto).toBe('250.10')
    })

    it('throws instead of silently rounding an amount with more than 2 decimal places', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ amount: 100.567 }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/invalid amount/)
    })

    it('throws instead of treating a null/empty amount as zero', async () => {
      const connector = makeConnector()
      const rawNull  = { ...rawItem({ amount: null }), __agentUsername: 'adminroyal' }
      const rawEmpty = { ...rawItem({ amount: '' }),   __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([rawNull])).rejects.toThrow(/has no amount/)
      await expect(connector.normalizeTransactions([rawEmpty])).rejects.toThrow(/has no amount/)
    })

    it('throws instead of coercing a boolean amount to a number (true -> 1)', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ amount: true }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/non-numeric amount/)
    })

    it('throws instead of treating a whitespace-only amount as zero', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ amount: '   ' }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/non-numeric amount/)
    })

    it('throws on a malformed decimal string amount (exponent notation)', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ amount: '1e3' }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/non-numeric amount/)
    })
  })

  // ── id strictness ─────────────────────────────────────────────────────────

  describe('normalizeTransactions() — id strictness', () => {
    it('throws when id is a number above Number.MAX_SAFE_INTEGER (already lost precision)', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ id: Number.MAX_SAFE_INTEGER + 10 }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/safe integer range/)
    })

    it('throws when id is an object (would otherwise stringify into a bogus identity)', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ id: { nested: true } }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/non-string\/number id/)
    })

    it('throws when id is a boolean', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ id: true }), __agentUsername: 'adminroyal' }
      await expect(connector.normalizeTransactions([raw])).rejects.toThrow(/non-string\/number id/)
    })
  })

  // ── Timezone (AR, UTC-3, no DST) ─────────────────────────────────────────

  describe('timezone handling', () => {
    it('a transaction exactly at midnight Argentina time gets the correct local fecha and a distinct UTC timestamp', async () => {
      const connector = makeConnector()
      // 2026-08-15T00:00:00 ART == 2026-08-15T03:00:00Z
      const raw = { ...rawItem({ createdAt: '2026-08-15T03:00:00.000Z' }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.fecha).toBe('2026-08-15')
      expect(tx.fecha_hora_utc).toBe('2026-08-15T03:00:00.000Z')
    })

    it('a transaction just before Argentina midnight stays on the previous local calendar day', async () => {
      const connector = makeConnector()
      // 2026-08-14T23:59:59 ART == 2026-08-15T02:59:59Z
      const raw = { ...rawItem({ createdAt: '2026-08-15T02:59:59.000Z' }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.fecha).toBe('2026-08-14')
      expect(tx.fecha_hora_utc).toBe('2026-08-15T02:59:59.000Z')
    })
  })

  // ── Identity compatible with the Excel importer ──────────────────────────

  describe('identity matches src/casino-import/excel.js exactly', () => {
    it('a numeric API id produces the same id_rec the importer would compute for the same source_id', async () => {
      const connector = makeConnector()
      const raw = { ...rawItem({ id: 918273 }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.source_id).toBe('918273')
      expect(tx.id_rec).toBe(recordId('918273'))
      expect(tx.id_rec).toBe('918273') // numeric ids pass through unchanged
    })

    it('a UUID-shaped API id hashes to the same negative id_rec the importer would compute', async () => {
      const connector = makeConnector()
      const uuid = 'a1b2c3d4-e5f6-47a8-9abc-1234567890ab'
      const raw = { ...rawItem({ id: uuid }), __agentUsername: 'adminroyal' }
      const [tx] = await connector.normalizeTransactions([raw])
      expect(tx.source_id).toBe(uuid)
      expect(tx.id_rec).toBe(recordId(uuid))
      expect(BigInt(tx.id_rec) < 0n).toBe(true)
    })
  })

  // ── insertTransactions(): collisions + cross-import dedup (real SQL logic, fake DB) ──

  describe('insertTransactions() — identity, collisions and cross-import dedup (against a real BaseCasinoConnector + fake Postgres)', () => {
    it('acquires the same named advisory lock the Excel importer uses, scoped to the DB transaction, before writing rows that carry source_id', async () => {
      const queries = []
      const client = {
        query: jest.fn(async (sql, params) => { queries.push(sql.trim()); return { rowCount: 0, rows: [] } }),
        release: jest.fn(),
      }
      const pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn() }
      const connector = new ArgenBetConnector(CONFIG, pool)

      const tx = (await connector.normalizeTransactions([{ ...rawItem({ id: 1 }), __agentUsername: 'adminroyal' }]))[0]
      await connector.insertTransactions('adminroyal', [tx])

      const beginIdx = queries.findIndex(q => q.startsWith('BEGIN'))
      const lockIdx  = queries.findIndex(q => q.includes('pg_advisory_xact_lock'))
      const insertIdx = queries.findIndex(q => q.startsWith('INSERT INTO casino_transactions'))
      expect(lockIdx).toBeGreaterThan(beginIdx)
      expect(lockIdx).toBeLessThan(insertIdx)
      expect(queries.find(q => q.includes('pg_advisory_xact_lock'))).toContain("hashtext('casino-excel-import')")
    })

    it('the same transaction ingested via API and via an Excel-shaped fixture produces exactly one row (no duplication)', async () => {
      const db = createFakeCasinoDb()
      const connector = new ArgenBetConnector(CONFIG, db.pool)

      const apiRaw = { ...rawItem({ id: 55501 }), __agentUsername: 'adminroyal' }
      const [apiTx] = await connector.normalizeTransactions([apiRaw])
      await connector.insertTransactions('adminroyal', [apiTx])

      // Same underlying transaction, as the Excel importer would have shaped it
      // (src/casino-import/excel.js): identical source_id -> identical id_rec.
      const excelShapedTx = {
        id_rec:         recordId('55501'),
        source_id:      '55501',
        username:       apiTx.username,
        agente:         apiTx.agente,
        tipo:           apiTx.tipo,
        monto:          apiTx.monto,
        fecha:          apiTx.fecha,
        fecha_hora_utc: apiTx.fecha_hora_utc,
        raw_detalles:   apiTx.raw_detalles,
      }
      await connector.insertTransactions('adminroyal', [excelShapedTx])

      expect(db.transactions).toHaveLength(1)
    })

    it('two transactions with the same amount but different ids remain separate rows (amount is never part of identity)', async () => {
      const db = createFakeCasinoDb()
      const connector = new ArgenBetConnector(CONFIG, db.pool)

      const tx1 = (await connector.normalizeTransactions([{ ...rawItem({ id: 111, amount: 1000 }), __agentUsername: 'adminroyal' }]))[0]
      const tx2 = (await connector.normalizeTransactions([{ ...rawItem({ id: 222, amount: 1000 }), __agentUsername: 'adminroyal' }]))[0]

      await connector.insertTransactions('adminroyal', [tx1, tx2])
      expect(db.transactions).toHaveLength(2)
    })

    it('throws (and the caller can roll back) when the same id_rec already exists with a conflicting source_id', async () => {
      const db = createFakeCasinoDb()
      const connector = new ArgenBetConnector(CONFIG, db.pool)

      const first = (await connector.normalizeTransactions([{ ...rawItem({ id: 777 }), __agentUsername: 'adminroyal' }]))[0]
      await connector.insertTransactions('adminroyal', [first])

      // Force an id_rec collision with a DIFFERENT source_id (simulates a hash
      // collision or a caller bug) — must fail loudly, never silently overwrite.
      const colliding = { ...first, source_id: 'not-the-same-source-id' }
      await expect(connector.insertTransactions('adminroyal', [colliding])).rejects.toThrow(/identity collision/)
      expect(db.transactions).toHaveLength(1) // nothing corrupted by the failed attempt
    })

    it('throws when the same id_rec already exists with a discordant amount', async () => {
      const db = createFakeCasinoDb()
      const connector = new ArgenBetConnector(CONFIG, db.pool)

      const first = (await connector.normalizeTransactions([{ ...rawItem({ id: 888, amount: 500 }), __agentUsername: 'adminroyal' }]))[0]
      await connector.insertTransactions('adminroyal', [first])

      const discordant = { ...first, monto: '999.99' }
      await expect(connector.insertTransactions('adminroyal', [discordant])).rejects.toThrow(/identity collision/)
    })

    it('does not falsely flag a Zeus-style numeric monto (100) as colliding with the same amount read back as a NUMERIC string ("100.00")', async () => {
      // Regression guard: a naive String(a) !== String(b) comparison would
      // treat these as different and break every Zeus re-sync.
      const db = createFakeCasinoDb()
      const connector = new ArgenBetConnector(CONFIG, db.pool)
      const first = (await connector.normalizeTransactions([{ ...rawItem({ id: 321, amount: 100 }), __agentUsername: 'adminroyal' }]))[0]
      await connector.insertTransactions('adminroyal', [first])

      // Same transaction, re-fetched — real Postgres NUMERIC(20,2) round-trips as "100.00".
      db.transactions[0].monto = '100.00'
      const replay = { ...first }
      await expect(connector.insertTransactions('adminroyal', [replay])).resolves.not.toThrow()
      expect(db.transactions).toHaveLength(1)
    })

    it('collapses an exact duplicate within the SAME batch instead of sending Postgres two rows for one conflict target', async () => {
      const db = createFakeCasinoDb()
      const connector = new ArgenBetConnector(CONFIG, db.pool)
      const raw = { ...rawItem({ id: 654 }), __agentUsername: 'adminroyal' }
      const tx = (await connector.normalizeTransactions([raw]))[0]

      // Two identical rows in the same call (e.g. two overlapping fetch pages).
      await connector.insertTransactions('adminroyal', [tx, { ...tx }])
      expect(db.transactions).toHaveLength(1)
    })

    it('throws on two contradictory rows sharing an id_rec within the SAME batch (not just against what is already in the DB)', async () => {
      const db = createFakeCasinoDb()
      const connector = new ArgenBetConnector(CONFIG, db.pool)
      const raw = { ...rawItem({ id: 987, amount: 111 }), __agentUsername: 'adminroyal' }
      const tx = (await connector.normalizeTransactions([raw]))[0]
      const contradictory = { ...tx, monto: '222.00' }

      await expect(connector.insertTransactions('adminroyal', [tx, contradictory])).rejects.toThrow(/identity collision within the same batch/)
      expect(db.transactions).toHaveLength(0) // whole batch rolled back, nothing partially written
    })
  })
})
