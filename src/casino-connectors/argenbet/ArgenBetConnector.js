'use strict'

const { BaseCasinoConnector } = require('../base/BaseCasinoConnector')
const { utcToLocalDate, extractUtcTimestamp, addOneDay } = require('../shared/dateHelpers')
const { recordId, amount: validateAmount } = require('../../casino-import/excel')

const PAGE_LIMIT     = 50  // ArgenBet's API hard-fails with HTTP 400 above this — never configurable.
const DEFAULT_MAX_PAGES = 500

/**
 * ArgenBet is the only universe of 3 confirmed agentUserIds (plan H10/D7,
 * `docs/PLAN-METRICAS-4-PLATAFORMAS.md`): the 9 children of `peaky` include
 * accounts that never operated players in this platform. Hardcoded (not
 * config-driven) on purpose — accepting an arbitrary agentIds map from
 * platforms.config.json would silently let a future edit sync the wrong
 * accounts. `config.agentIds`, if present, must match this exactly.
 */
const ALLOWED_AGENT_IDS = Object.freeze({
  adminbtc:   '637249', // -> betcoin
  adminzeus:  '637252', // -> ofizeus
  adminroyal: '637255', // -> royal
})

/**
 * Connector for ArgenBet (admin.argenbet.net).
 *
 * API base:  ARGENBET_API_BASE || config.baseUrl
 * Endpoint:  GET /api/backoffice/v1/account-transfers/player
 * Auth:      Bearer JWT only (no X-Api-Key, unlike Zeus/Bet30).
 *
 * Token (today): ARGENBET_PLAYER_TOKEN, a static token set manually — the
 * real login endpoint has not been captured yet (see `authenticate()` TODO
 * below). Do NOT invent the login contract; wait for sanitized captures from
 * the account owner (URL, method, body, token path in the response, TTL,
 * refresh flow).
 *
 * Pagination: offset-based, `limit` FIXED at 50 (the API returns HTTP 400 for
 * anything higher — confirmed manually, see `docs/argenbet-export-consola.js`).
 * A batch smaller than `limit` means "no more data" and ends the loop. If
 * `config.maxPages` is exceeded without that happening, this throws instead
 * of returning whatever was collected so far — a sync that silently returns
 * a partial page range must never look like a completed sync.
 *
 * Player-role rule (H10): the player side of a transfer is whichever of
 * `toUserRole`/`fromUserRole` equals `'player'` — NOT a fixed `toUsername`,
 * which is only correct for INCOME and silently wrong for OUTCOME. The
 * transaction's `agente` is always the agentUserId used to REQUEST the page
 * it came from (not `creatorUsername` from the payload) — this preserves
 * per-agent attribution even when a caller iterates several agentIds in the
 * same run (fase 4).
 */
class ArgenBetConnector extends BaseCasinoConnector {
  /**
   * @param {object} config
   * @param {import('pg').Pool} pool
   * @param {{ login: () => Promise<{ token: string }> } | null} loginAdapter
   *   Injectable login adapter (fase 2 requirement): the real ArgenBet login
   *   endpoint is not known yet, so production code has nothing to call.
   *   Without one, `authenticate()` is a safe no-op (see its own docstring
   *   for why) and a persistently-401ing static token still fails loudly via
   *   `_fetchWithRetry`'s own non-retriable-4xx error. Tests inject a fake
   *   adapter to exercise the re-auth-on-401 success path without inventing
   *   a real contract. `config.loginUrl` is reserved for when the real
   *   endpoint is captured (see TODO in `authenticate()`).
   */
  constructor(config, pool, loginAdapter = null) {
    super(config, pool)

    this.loginAdapter = loginAdapter

    this.baseUrl = (process.env[config.baseUrlEnvVar] || config.baseUrl).trim()

    // The static token is only mandatory when there is no other way to ever
    // obtain one: with a loginAdapter injected, authenticate() can populate
    // this.playerToken on its own (e.g. right before the first request, or
    // after a 401) — forcing ARGENBET_PLAYER_TOKEN too would make it
    // impossible to run in "adapter-only" mode once the real login exists.
    const staticToken = process.env[config.playerTokenEnvVar]?.trim()
    if (!loginAdapter) {
      this._validateEnvVars([config.playerTokenEnvVar])
    }
    this.playerToken = staticToken || null

    this.agentIds = this._resolveAgentIds(config.agentIds)
    this.maxPages = this._resolveMaxPages(config.maxPages)
  }

  _resolveMaxPages(configured) {
    const value = configured ?? DEFAULT_MAX_PAGES
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`ArgenBet: config.maxPages must be a positive integer, got: ${JSON.stringify(configured)}`)
    }
    return value
  }

  _resolveAgentIds(configured) {
    const source      = configured ?? ALLOWED_AGENT_IDS
    const allowedKeys = Object.keys(ALLOWED_AGENT_IDS)
    const sourceKeys  = Object.keys(source)

    const isExactMatch =
      sourceKeys.length === allowedKeys.length &&
      allowedKeys.every(k => String(source[k]) === ALLOWED_AGENT_IDS[k])

    if (!isExactMatch) {
      throw new Error(
        'ArgenBet: config.agentIds must be exactly the 3 confirmed agents ' +
        `(${allowedKeys.map(k => `${k}=${ALLOWED_AGENT_IDS[k]}`).join(', ')}) — ` +
        `no more, no fewer, no substitutes. Got: ${JSON.stringify(source)}`
      )
    }
    return { ...ALLOWED_AGENT_IDS }
  }

  /**
   * TODO(argenbet-login): the real login endpoint is NOT captured yet. Per
   * the coordinator's brief, do not invent it — the owner still owes:
   *   - loginUrl (full path) and HTTP method
   *   - request body shape (fields, encoding)
   *   - path to the token inside the response body
   *   - token TTL and whether/how it's refreshed (refresh token? re-login?)
   * Until then, this only supports:
   *   (a) a static token via ARGENBET_PLAYER_TOKEN (set manually, rotated by
   *       hand when it expires), and
   *   (b) an INJECTED `loginAdapter` (constructor 3rd arg) for callers who
   *       already have a working login implementation elsewhere and want
   *       `_fetchWithRetry`'s 401-triggered re-auth to use it. This is how
   *       Fase 4 (or the account owner) plugs in the real thing later
   *       without touching this file again.
   * With neither configured, a 401 must still fail loudly eventually — never
   * loop forever and never look like a successful, empty sync. It just isn't
   * THIS method's job to throw that: `scripts/sync-casino-players-live.js`
   * calls `connector.authenticate()` unconditionally once at startup, for
   * every platform, before the first request — exactly like it does for
   * ZeusConnector, whose own `authenticate()` is a safe no-op when no
   * auto-login credentials are configured (falls back to its static token).
   * If this method threw here, the static-`ARGENBET_PLAYER_TOKEN`-only mode
   * the brief explicitly asks for ("desarrollo/pruebas mientras no exista
   * login real") would be unusable — the orchestrator would crash before
   * ever making a request. The actual visible failure for a truly expired
   * static token with no adapter still happens: `_fetchWithRetry` calls this
   * same method again on the first 401, gets the same no-op, retries once
   * with the same (still-expired) token, gets 401 again, and — because H11's
   * "one retry" budget is now used up — throws `HTTP 401 (non-retriable)`
   * out of `fetchTransactions()`. That is the loud failure; it just isn't
   * raised from inside `authenticate()` itself.
   */
  async authenticate() {
    if (!this.loginAdapter) {
      this.log.warn(
        'ArgenBet: no login adapter configured — relying on the static ARGENBET_PLAYER_TOKEN as-is. ' +
        'It cannot be refreshed automatically; if requests start failing with a persistent 401, rotate ' +
        'it by hand (the real login endpoint is not captured yet, see the TODO on this method).'
      )
      return
    }

    // Same shape as GanamosConnector's loginAdapter contract: the adapter
    // needs the actual credentials to log in with, not just "please log in
    // somehow" — config.loginUrl (still null until the real endpoint is
    // captured, see the TODO above) and ARGENBET_ADMIN_USER/_PASSWORD, read
    // fresh from env on every call so a rotated credential takes effect on
    // the next authenticate() without restarting the process.
    const adminUser     = process.env[this.config.adminUserEnvVar]?.trim()
    const adminPassword = process.env[this.config.adminPasswordEnvVar]?.trim()
    if (!adminUser || !adminPassword) {
      throw new Error(
        `ArgenBet: a loginAdapter is configured but ${this.config.adminUserEnvVar}/${this.config.adminPasswordEnvVar} ` +
        'are not set — nothing to log in with.'
      )
    }

    let result
    try {
      result = await this.loginAdapter.login({
        loginUrl:    this.config.loginUrl ?? null,
        credentials: { user: adminUser, password: adminPassword },
      })
    } catch (err) {
      // Same reasoning as GanamosConnector._loginAgent: the adapter is
      // external, injected code — its rejection could easily echo back the
      // very credentials it just tried to send. Never propagate err.message
      // verbatim, not even sanitized — the adapter's own logs are where
      // that detail belongs.
      throw new Error('ArgenBet: login adapter failed (see the adapter\'s own logs for details)')
    }
    const token = result && result.token
    if (!token) {
      throw new Error('ArgenBet: loginAdapter.login() resolved without a token')
    }
    this.playerToken = token
    this.log.info('Player token refreshed via injected login adapter')
  }

  // ── API ───────────────────────────────────────────────────────────────────

  async fetchTransactions(agentUsername, startDate, endDate) {
    const agentUserId = this.agentIds[agentUsername]
    if (!agentUserId) {
      throw new Error(
        `ArgenBet: "${agentUsername}" is not one of the 3 allowed agents ` +
        `(${Object.keys(this.agentIds).join(', ')})`
      )
    }

    const { dateFrom, dateTo } = buildDateRangeParams(startDate, endDate)

    const items = []
    let offset = 0
    let page   = 0

    while (true) {
      if (page >= this.maxPages) {
        throw new Error(
          `ArgenBet: exceeded maxPages=${this.maxPages} for agent "${agentUsername}" (offset=${offset}) — ` +
          'refusing to return a partial result as if the sync had completed. Increase config.maxPages ' +
          'only after confirming the range is legitimately this large.'
        )
      }

      const url = buildUrl(this.baseUrl, this.config.endpoint, agentUserId, dateFrom, dateTo, offset)

      const buildOptions = () => ({
        headers: {
          'Authorization': `Bearer ${this.playerToken}`,
          'Accept':        'application/json, text/plain, */*',
        },
        signal: AbortSignal.timeout(60_000),
      })

      this.log.debug({ agent: agentUsername, offset, page }, 'Fetching transactions')

      const res  = await this._fetchWithRetry(url, buildOptions, `agent "${agentUsername}" offset=${offset}`)
      const body = await res.json()
      const batch = extractBatch(body)

      // We requested limit=50; anything above that means the API ignored our
      // param or something is badly wrong upstream. Our "batch < limit ends
      // pagination" rule (H8/plan §3, no `total` field) depends on `limit`
      // being exactly what we asked for — silently accepting a bigger page
      // would make that rule unreliable and risk mis-paginating over data.
      if (batch.length > PAGE_LIMIT) {
        throw new Error(
          `ArgenBet: API returned ${batch.length} rows for agent "${agentUsername}" offset=${offset}, ` +
          `more than the requested limit=${PAGE_LIMIT} — refusing to paginate against an API that isn't ` +
          'honoring the limit param.'
        )
      }

      for (const item of batch) items.push({ ...item, __agentUsername: agentUsername })

      page++
      this.log.debug({ agent: agentUsername, batchSize: batch.length }, 'Batch received')

      if (batch.length < PAGE_LIMIT) break // last page (spec: a batch smaller than limit ends pagination)
      offset += batch.length
    }

    return items
  }

  /**
   * Per-record policy (deliberately narrow about what counts as "discard"):
   *
   *   DISCARD with a warning log — ONLY for records that are genuinely out
   *   of scope of this sync, the same bar Zeus already applies to
   *   "indirecto" capital transfers: an operation that isn't INCOME/OUTCOME
   *   (e.g. a bonus — bonuses are explicitly out of scope of the whole plan,
   *   fase 5). These are legitimate rows this connector was never meant to
   *   ingest.
   *
   *   THROW (abort the whole normalize/sync call) for anything else that's
   *   malformed on an otherwise in-scope INCOME/OUTCOME record: ambiguous or
   *   missing player role, missing/blank id or username, unparsable
   *   createdAt, invalid amount. H8 already confirmed every real row carries
   *   an id — encountering one without it (or with any of the above) means
   *   something is actually wrong, not "out of scope". Fase 4's incremental
   *   sync advances its checkpoint from the max timestamp actually
   *   processed; silently dropping an in-scope row here would let that
   *   checkpoint move past a real transaction that was never persisted, with
   *   no way to ever recover it. A loud failure here is exactly the
   *   "an ArgenBet sync must never exit 0 having silently lost rows" the
   *   top-level plan asks for.
   */
  async normalizeTransactions(rawData) {
    const normalized = []

    for (const raw of rawData) {
      const { __agentUsername: agente, ...item } = raw
      const errCtx = { agent: agente, id: item.id }

      const op   = String(item.operation || '').toUpperCase()
      const tipo = op === 'INCOME' ? 'carga' : op === 'OUTCOME' ? 'retiro' : null
      if (!tipo) {
        this.log.warn({ ...errCtx, operation: item.operation }, 'ArgenBet: discarding transaction — out of scope operation (not INCOME/OUTCOME, e.g. a bonus)')
        continue
      }

      // H10: the player is whichever side has *UserRole === 'player' — never
      // a fixed field. Both-or-neither is ambiguous on an otherwise in-scope
      // INCOME/OUTCOME record — that is malformed data, not "out of scope",
      // so it must fail loudly rather than be quietly dropped.
      const toIsPlayer   = item.toUserRole === 'player'
      const fromIsPlayer = item.fromUserRole === 'player'
      if (toIsPlayer === fromIsPlayer) {
        throw new Error(`ArgenBet: transaction id=${item.id ?? '?'} has an ambiguous/missing player role (toUserRole/fromUserRole) on an INCOME/OUTCOME record`)
      }
      const side     = toIsPlayer ? 'to' : 'from'
      const usernameRaw = item[`${side}Username`]
      const username    = typeof usernameRaw === 'string' ? usernameRaw.trim() : ''
      if (!username) {
        throw new Error(`ArgenBet: transaction id=${item.id ?? '?'} is missing the player username (${side}Username)`)
      }

      const rawId = item.id ?? item.transferId ?? item.transactionId ?? item.uuid ?? null
      // Same strictness as GanamosConnector.normalizeTransactions: only a
      // string or a SAFE-integer number is an acceptable id shape. A JS
      // number above Number.MAX_SAFE_INTEGER has already lost precision by
      // the time JSON parsing handed it to us, and an object/boolean id
      // would otherwise silently stringify into a bogus identity
      // ("[object Object]"/"true"). Whitespace-only is rejected too, not
      // just null/'' — `String("   ").trim()` would otherwise look like a
      // valid empty-after-trim id.
      if (rawId != null && typeof rawId !== 'string' && typeof rawId !== 'number') {
        throw new Error(`ArgenBet: transaction for player "${username}" has a non-string/number id: ${JSON.stringify(rawId)}`)
      }
      if (typeof rawId === 'number' && !Number.isSafeInteger(rawId)) {
        throw new Error(`ArgenBet: transaction for player "${username}" has an id outside safe integer range (already lost precision): ${rawId}`)
      }
      const source_id = rawId == null ? '' : String(rawId).trim()
      if (!source_id) {
        throw new Error(`ArgenBet: transaction for player "${username}" has no stable id (id/transferId/transactionId/uuid all missing) — H8 confirmed every real row has one`)
      }
      // Identity compatible with the Excel importer (src/casino-import/excel.js):
      // numeric ids stay themselves; anything else (e.g. a UUID) becomes a
      // deterministic negative SHA-256-derived id_rec. Same input -> same
      // id_rec/source_id from either ingestion path, so the API can never
      // duplicate what was already imported from Excel, and vice versa.
      const id_rec = recordId(source_id)

      if (!item.createdAt) {
        throw new Error(`ArgenBet: transaction id=${source_id} for player "${username}" is missing createdAt`)
      }
      const fecha          = utcToLocalDate(item.createdAt)
      const fecha_hora_utc = extractUtcTimestamp(item.createdAt)
      if (!fecha || !fecha_hora_utc || isNaN(Date.parse(fecha_hora_utc))) {
        throw new Error(`ArgenBet: transaction id=${source_id} for player "${username}" has an unparsable createdAt: ${JSON.stringify(item.createdAt)}`)
      }

      // D3: pesos con centavos, sin redondear. `null`/`''`/non-finite amounts
      // must never silently become 0 — that would fabricate a fake
      // zero-value transaction. Reuses the Excel importer's own decimal
      // validator (src/casino-import/excel.js `amount()`) so a value with
      // more than 2 decimal places (which should never happen upstream, but
      // would otherwise get silently rounded by `toFixed(2)`) fails loudly
      // instead of quietly losing precision.
      if (item.amount == null || item.amount === '') {
        throw new Error(`ArgenBet: transaction id=${source_id} for player "${username}" has no amount`)
      }
      // Strict on purpose (same rule as GanamosConnector.parseStrictAmount):
      // plain `Number(item.amount)` alone would accept `true` (-> 1), a
      // whitespace-only string (-> 0, fabricating a fake zero-value
      // transaction instead of erroring), exponent notation, or more than 2
      // decimal places — quietly corrupting a monto before validateAmount
      // ever sees it.
      const parsedAmount = parseStrictAmount(item.amount)
      if (parsedAmount === null) {
        throw new Error(`ArgenBet: transaction id=${source_id} for player "${username}" has a non-numeric amount: ${JSON.stringify(item.amount)}`)
      }
      const absAmount = Math.abs(parsedAmount)
      let monto
      try {
        monto = validateAmount(absAmount)
      } catch (e) {
        throw new Error(`ArgenBet: transaction id=${source_id} for player "${username}" has an invalid amount (${e.message}): ${JSON.stringify(item.amount)}`)
      }

      normalized.push({
        id_rec,
        source_id,
        username,
        // D2/H9: agente is the agentUserId's username that requested THIS
        // page, not the payload's creatorUsername (may be missing/different
        // — e.g. peaky-level transfers) — we must not lose which agent
        // originated the request even mid multi-agent iteration.
        agente,
        tipo,
        monto,
        fecha,
        fecha_hora_utc,
        raw_detalles:   item.operation ? String(item.operation) : tipo,
      })
    }

    return normalized
  }

  async healthCheck() {
    try {
      const [agentUsername] = Object.keys(this.agentIds)
      const agentUserId     = this.agentIds[agentUsername]
      const today            = new Date().toISOString().slice(0, 10)
      const { dateFrom, dateTo } = buildDateRangeParams(today, today)
      const url = buildUrl(this.baseUrl, this.config.endpoint, agentUserId, dateFrom, dateTo, 0)

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.playerToken}` },
        signal:  AbortSignal.timeout(10_000),
      })
      const healthy = res.status < 500
      if (healthy) {
        this.log.info({ status: res.status }, 'Health check passed')
      } else {
        this.log.warn({ status: res.status }, 'Health check failed — server error')
      }
      return healthy
    } catch (err) {
      this.log.warn({ error: err.message }, 'Health check failed — network error')
      return false
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Strict amount parser — same rule as GanamosConnector's own
 * `parseStrictAmount` (kept as a small local copy rather than a shared
 * export: both connectors' `normalizeTransactions` call it inline and a
 * shared module would be one more indirection for a 6-line regex). Accepts a
 * finite JS number as-is, or a string that is exactly an optionally-signed
 * decimal with at most 2 fractional digits — never routed through `Number()`
 * before the regex validates its shape. Returns `null` for anything else,
 * including booleans, objects, whitespace-only strings, NaN/Infinity.
 */
function parseStrictAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(trimmed)) return null
  return Number(trimmed)
}

function buildUrl(baseUrl, endpoint, agentUserId, dateFrom, dateTo, offset) {
  const params = new URLSearchParams()
  params.append('operations[]', 'INCOME')
  params.append('operations[]', 'OUTCOME')
  params.set('agentUserId', agentUserId)
  params.set('dateFrom', dateFrom)
  params.set('dateTo', dateTo)
  params.set('offset', String(offset))
  params.set('limit', String(PAGE_LIMIT))
  return `${baseUrl}${endpoint}?${params}`
}

/**
 * Converts a single date/timestamp value to a full ISO-8601 UTC string,
 * interpreting bare `YYYY-MM-DD` dates as Argentina local midnight (fixed
 * UTC-3, no DST — same convention as `shared/dateHelpers.js`). Accepts `Date`
 * instances and epoch-millis numbers as well as strings, on purpose: fase 2
 * only ever calls this with day-level strings, but fase 4's incremental sync
 * needs to pass exact timestamps (e.g. `MAX(fecha_hora_utc) - 30min`)
 * through the same range-building logic without a rewrite.
 */
function toArgentinaIso(value) {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') return new Date(value).toISOString()

  const s = String(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00-03:00`).toISOString()
  return new Date(s).toISOString() // already a full timestamp (with or without explicit offset)
}

/**
 * `hasta` follows the same exclusive-end convention as ZeusConnector
 * (`shared/dateHelpers.addOneDay`): a bare `YYYY-MM-DD` end date is bumped to
 * the next day at Argentina midnight so the whole day is included. A
 * timestamp `hasta` (fase 4) is used exactly as given — the caller already
 * decided the exact boundary.
 */
function buildDateRangeParams(desde, hasta) {
  const dateFrom = toArgentinaIso(desde)
  const isPlainDate = /^\d{4}-\d{2}-\d{2}$/.test(String(hasta))
  const dateTo = isPlainDate ? toArgentinaIso(addOneDay(hasta)) : toArgentinaIso(hasta)

  if (Date.parse(dateFrom) > Date.parse(dateTo)) {
    throw new Error(`ArgenBet: invalid date range — dateFrom (${dateFrom}) is after dateTo (${dateTo})`)
  }
  return { dateFrom, dateTo }
}

/**
 * The API has no `total` field (H8/plan §3): pagination only ends when a
 * batch comes back smaller than `limit`. But the *shape* of a single
 * response must still be exactly one of the documented forms — anything
 * else (a string, a bare error object, a differently-shaped payload) means
 * this code failed to understand the response and MUST throw rather than
 * silently treat it as "0 rows, sync done".
 */
function extractBatch(body) {
  if (Array.isArray(body)) return body
  if (body && typeof body === 'object') {
    const candidate = body.items ?? body.data ?? body.rows
    if (Array.isArray(candidate)) return candidate
  }
  throw new Error(
    'ArgenBet: unexpected response shape from account-transfers/player ' +
    '(expected an array, or an object with items/data/rows) — refusing to treat this as an empty page'
  )
}

module.exports = { ArgenBetConnector, ALLOWED_AGENT_IDS, buildDateRangeParams }
