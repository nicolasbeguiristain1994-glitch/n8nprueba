'use strict'

const { BaseCasinoConnector } = require('../base/BaseCasinoConnector')
const { utcToLocalDate, addOneDay } = require('../shared/dateHelpers')
const { recordId, amount: validateAmount } = require('../../casino-import/excel')

const PAGE_COUNT           = 500 // confirmed OK against the panel (10x Argenbet's limit=50)
const DEFAULT_MAX_PAGES    = 200 // per-day guard — docs/ganamos-export-consola.js uses the same cap
const STALE_SYNC_DAYS      = 7   // plan: warn when an agent's last successful sync is older than this

/**
 * Ganamos operates exactly 6 confirmed agents (plan "Universo de agentes",
 * 2026-09-08). The tree has more nodes (adminfara, admstock, admolimpus,
 * admmega, royalautos, admolympus, generalfranqui, general24/7, royalgana)
 * that are NOT operational — hardcoded here on purpose, same reasoning as
 * ArgenBetConnector.ALLOWED_AGENT_IDS: accepting an arbitrary agentIds map
 * from platforms.config.json would silently let a future edit sync accounts
 * that were never vetted. `config.agentIds`, if present, must match exactly.
 */
const ALLOWED_AGENT_IDS = Object.freeze({
  adminbtc:     '23851783', // -> betcoin
  adminzeus:    '23851856', // -> ofizeus
  adminroyal:   '24044323', // -> royal
  admbigwin:    '24045611', // -> bigwin
  amdfarabet:   '24050612', // -> farabet (note: "amd", not adminfara — a different, non-operational account)
  adminimperio: '34139043', // -> imperio
})

/**
 * Connector for Ganamos (agents.ganamosnet.org).
 *
 * API base:  GANAMOS_API_BASE || config.baseUrl
 * Endpoint:  GET /api/agent_admin/user/{agentId}/payment/history/
 * Auth:      **session cookie, per agent** — structurally different from
 *   Zeus/Bet30/Argenbet's single shared token. The endpoint only returns the
 *   full movement history of the account whose session is making the
 *   request (plan Fase 0 punto 5, 2026-09-08 sondeo): querying a
 *   subordinate's id from an administrator session ("admganamos") returns
 *   only a handful of rows (measured: 80 tree nodes summed to $100.100 in
 *   mayo 2026 against $67.217.847 shown in the panel for that same period).
 *   There is no "one admin session covers everyone" shortcut here — this
 *   connector needs 6 independent cookie jars, one per agent, never a common
 *   administrator session.
 *
 * `this.agentCookieJars` (Map: agentUsername -> Map<cookieName, value>) is
 * the ONLY place session state lives. There is deliberately no single mutable
 * "this.currentAgent" — two agents can sync concurrently through the same
 * connector instance (fase 4 will parallelize this the same way
 * sync-casino-players-live.js already does for Zeus/Bet30), and a shared
 * "current agent" field would let agent B's request overwrite which agent a
 * concurrent 401 retry for agent A should re-authenticate as. Every call
 * that touches a session is parameterized by `agentUsername` and reads/writes
 * only that key of the map.
 *
 * Window: the panel does not accept ranges above 24h for this agent-scoped
 * endpoint (confirmed by the account owner) — `fetchTransactions` always
 * iterates day by day, never a single multi-day request.
 *
 * Detail retention: Ganamos only keeps per-transaction detail for ~60 days;
 * older ranges return `{transfers: [], details: {total_count: 0, ...}}` even
 * though the aggregated totals for that period still exist elsewhere. This
 * connector does not (and cannot) recover older detail — see
 * `checkStaleSync()` below and docs/runbooks/casino-api-sync-implementation.md.
 */
class GanamosConnector extends BaseCasinoConnector {
  /**
   * @param {object} config
   * @param {import('pg').Pool} pool
   * @param {{ login: (args: { agente: string, loginUrl: string|null, credentials: { user: string, password: string } }) => Promise<{ cookie: string }> } | null} loginAdapter
   *   Injectable login adapter (same pattern as ArgenBetConnector's 3rd ctor
   *   arg): the real Ganamos login endpoint is NOT captured yet. Without one,
   *   `_loginAgent()` throws for any agent that has GANAMOS_<AGENTE>_USER/
   *   PASSWORD but no GANAMOS_<AGENTE>_SESSION_COOKIE — a clear, per-agent
   *   failure, never a silent no-op. Tests inject a fake adapter to exercise
   *   the login/re-auth-on-401 paths without inventing a real contract.
   *   `config.loginUrl` is reserved for when the real endpoint is captured.
   */
  constructor(config, pool, loginAdapter = null) {
    super(config, pool)

    this.loginAdapter = loginAdapter
    this.baseUrl       = (process.env[config.baseUrlEnvVar] || config.baseUrl).trim()
    this.agentIds       = this._resolveAgentIds(config.agentIds)
    this.maxPages       = this._resolveMaxPages(config.maxPages)

    /**
     * @type {Map<string, Map<string, string>>} agentUsername -> cookie jar
     * (cookie name -> value). A real jar, not a single fixed string: Ganamos'
     * session-cookie auth can rotate the session id mid-run via `Set-Cookie`
     * on any response (common for server-rendered session backends), and a
     * connector that only ever sent the cookie captured at login time would
     * silently start failing every request after a rotation instead of
     * picking up the new value. `_applySetCookies()` merges by cookie NAME
     * (multiple cookies can coexist) and drops a name when its `Set-Cookie`
     * carries `Max-Age<=0` or a past `Expires` — never a naive
     * comma-split of the raw header (a `Set-Cookie`'s own `Expires` attribute
     * contains a comma, e.g. "Expires=Wed, 09 Jun 2021 ..."; joining/splitting
     * multiple Set-Cookie values on "," would corrupt that date). Uses the
     * Fetch `Headers.getSetCookie()` API (available in this Node runtime) to
     * get each `Set-Cookie` line un-joined, never `headers.get('set-cookie')`
     * (which comma-joins them the same corrupting way).
     */
    this.agentCookieJars = new Map()
  }

  _resolveMaxPages(configured) {
    const value = configured ?? DEFAULT_MAX_PAGES
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Ganamos: config.maxPages must be a positive integer, got: ${JSON.stringify(configured)}`)
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
        'Ganamos: config.agentIds must be exactly the 6 confirmed agents ' +
        `(${allowedKeys.map(k => `${k}=${ALLOWED_AGENT_IDS[k]}`).join(', ')}) — ` +
        `no more, no fewer, no substitutes. Got: ${JSON.stringify(source)}`
      )
    }
    return { ...ALLOWED_AGENT_IDS }
  }

  /**
   * Global hook, called once at startup by sync-casino-players-live.js
   * (identical call site as every other connector: `await connector.authenticate()`
   * before the agent loop). Ganamos has no single connector-wide credential to
   * validate — it only checks, per agent, whether SOME usable credential is
   * configured (a static dev session cookie or a user/password pair), and
   * logs a warning for agents that have neither. It never throws: a missing
   * credential for one agent must not prevent the other 5 from being synced
   * (plan Fase 3 requirement) — the actual login happens lazily, per agent,
   * from `fetchTransactions()` the first time that agent is synced, and a
   * missing/failed login surfaces there as a normal per-agent sync failure
   * that `runAgent()` in the orchestrator already catches without aborting
   * the batch.
   */
  async authenticate() {
    for (const agentUsername of Object.keys(this.agentIds)) {
      const { hasCredential } = this._resolveAgentCredentialSource(agentUsername)
      if (!hasCredential) {
        this.log.warn(
          { agent: agentUsername },
          `Ganamos: no credentials configured for agent "${agentUsername}" ` +
          `(GANAMOS_${agentUsername.toUpperCase()}_SESSION_COOKIE, or ` +
          `GANAMOS_${agentUsername.toUpperCase()}_USER + _PASSWORD) — this agent will fail visibly when synced, others are unaffected`
        )
      }
    }
  }

  _resolveAgentCredentialSource(agentUsername) {
    const key            = agentUsername.toUpperCase()
    const sessionCookie   = process.env[`GANAMOS_${key}_SESSION_COOKIE`]?.trim()
    const user            = process.env[`GANAMOS_${key}_USER`]?.trim()
    const password         = process.env[`GANAMOS_${key}_PASSWORD`]?.trim()
    return {
      sessionCookie: sessionCookie || null,
      user:          user || null,
      password:      password || null,
      hasCredential: !!sessionCookie || !!(user && password),
    }
  }

  /**
   * Establishes (or refreshes) the session for exactly one agent — never
   * touches any other agent's entry in `this.agentCookieJars`.
   *
   * TODO(ganamos-login): the real login endpoint is NOT captured yet (plan
   * Fase 0 punto 5 / Fase 3). Per the coordinator's brief, do not invent it —
   * the owner still owes: loginUrl, HTTP method, request body shape, and how
   * the session cookie comes back (Set-Cookie header? body field?). Until
   * then this supports:
   *   (a) GANAMOS_<AGENTE>_SESSION_COOKIE — a static cookie captured by hand
   *       from an already-logged-in browser tab, for local development only
   *       (documented in .env.example and the runbook, never a real value in
   *       either), and
   *   (b) an INJECTED `loginAdapter` (constructor 3rd arg) for callers who
   *       already have a working login implementation elsewhere. This is how
   *       Fase 4 (or the account owner) plugs in the real thing later without
   *       touching this file again.
   * Credentials, cookies, and login response bodies are never logged —
   * `this.log.*` calls in this method only ever reference field NAMES
   * (agent, env var names), never their values.
   */
  async _loginAgent(agentUsername) {
    const { sessionCookie, user, password } = this._resolveAgentCredentialSource(agentUsername)

    if (sessionCookie) {
      // The static env var is a plain `Cookie` header VALUE (what a browser
      // would send), not a `Set-Cookie` response — parsed into the jar the
      // same way so later `Set-Cookie` rotations merge into it by name
      // instead of clobbering it.
      this._setJarFromCookieHeader(agentUsername, sessionCookie)
      this.log.info({ agent: agentUsername }, 'Ganamos: using static GANAMOS_<AGENTE>_SESSION_COOKIE (dev only, not a real login)')
      return
    }

    if (!user || !password) {
      throw new Error(
        `Ganamos: missing credentials for agent "${agentUsername}" — set GANAMOS_${agentUsername.toUpperCase()}_SESSION_COOKIE ` +
        `(dev) or GANAMOS_${agentUsername.toUpperCase()}_USER + GANAMOS_${agentUsername.toUpperCase()}_PASSWORD`
      )
    }

    if (!this.loginAdapter) {
      throw new Error(
        `Ganamos: agent "${agentUsername}" has credentials configured but no login endpoint is implemented yet ` +
        '(the real login contract is not captured — see the TODO on _loginAgent). Inject a loginAdapter, or set ' +
        `GANAMOS_${agentUsername.toUpperCase()}_SESSION_COOKIE for local testing.`
      )
    }

    let result
    try {
      result = await this.loginAdapter.login({
        agente:   agentUsername,
        loginUrl: this.config.loginUrl ?? null,
        credentials: { user, password },
      })
    } catch (err) {
      // The adapter is external, injected code (real implementation owned by
      // whoever plugs in the real login later) — its rejection could easily
      // echo back request/response details (a login form's error page, an
      // HTTP client's error body) that contain the very credentials or
      // cookies we're trying to establish. Never propagate `err.message`
      // verbatim; the adapter's own logs are where that detail belongs.
      throw new Error(`Ganamos: login adapter failed for agent "${agentUsername}" (see the adapter's own logs for details)`)
    }
    const cookie = result && result.cookie
    if (!cookie) {
      throw new Error(`Ganamos: loginAdapter.login() for agent "${agentUsername}" resolved without a cookie`)
    }
    this._setJarFromCookieHeader(agentUsername, cookie)
    this.log.info({ agent: agentUsername }, 'Ganamos: session established via injected login adapter')
  }

  // ── Cookie jar (per agent) ───────────────────────────────────────────────

  _hasSession(agentUsername) {
    const jar = this.agentCookieJars.get(agentUsername)
    return !!jar && jar.size > 0
  }

  _cookieHeader(agentUsername) {
    const jar = this.agentCookieJars.get(agentUsername)
    if (!jar || !jar.size) return ''
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  _setJarFromCookieHeader(agentUsername, cookieHeaderStr) {
    const jar = new Map()
    for (const pair of String(cookieHeaderStr).split(';')) {
      const idx = pair.indexOf('=')
      if (idx <= 0) continue
      const name  = pair.slice(0, idx).trim()
      const value = pair.slice(idx + 1).trim()
      if (name) jar.set(name, value)
    }
    this.agentCookieJars.set(agentUsername, jar)
  }

  /**
   * Merges any `Set-Cookie` response headers into this agent's jar — additive
   * by cookie name (a rotated session id replaces only that name, other
   * cookies the jar already held survive), and removes a name outright when
   * its `Set-Cookie` carries an expiry in the past (`Max-Age<=0` or a past
   * `Expires`). Never touches any other agent's jar.
   */
  _applySetCookies(agentUsername, res) {
    const setCookieLines = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    if (!setCookieLines.length) return

    const jar = this.agentCookieJars.get(agentUsername) ?? new Map()
    for (const line of setCookieLines) {
      const parsed = parseSetCookie(line)
      if (!parsed) continue
      if (parsed.expired) jar.delete(parsed.name)
      else jar.set(parsed.name, parsed.value)
    }
    this.agentCookieJars.set(agentUsername, jar)
  }

  // ── API ───────────────────────────────────────────────────────────────────

  async fetchTransactions(agentUsername, startDate, endDate) {
    const agentId = this.agentIds[agentUsername]
    if (!agentId) {
      throw new Error(
        `Ganamos: "${agentUsername}" is not one of the 6 allowed agents ` +
        `(${Object.keys(this.agentIds).join(', ')})`
      )
    }

    if (!this._hasSession(agentUsername)) {
      await this._loginAgent(agentUsername)
    }

    const items = []
    for (const day of buildDayWindows(startDate, endDate)) {
      const dayItems = await this._fetchDay(agentUsername, agentId, day)
      for (const item of dayItems) items.push({ ...item, __agentUsername: agentUsername })
    }
    return items
  }

  async _fetchDay(agentUsername, agentId, day) {
    const dateFrom = `${day}T00:00:00`
    const dateTo   = `${addOneDay(day)}T00:00:00`

    const collected = []
    let page = 0

    while (true) {
      if (page >= this.maxPages) {
        throw new Error(
          `Ganamos: exceeded maxPages=${this.maxPages} for agent "${agentUsername}" day ${day} — ` +
          'refusing to return a partial result as if the day had synced completely.'
        )
      }

      const url = buildUrl(this.baseUrl, this.config.endpoint, agentId, dateFrom, dateTo, page, PAGE_COUNT)

      const buildOptions = () => ({
        headers: {
          // Cookie is read fresh from the jar on every attempt (including
          // after a scoped reauth) — never cached in a local variable that
          // could go stale across the retry.
          'Cookie':  this._cookieHeader(agentUsername),
          'Accept':  'application/json',
        },
        signal: AbortSignal.timeout(60_000),
      })

      // Scoped reauth (see BaseCasinoConnector._fetchWithRetry docstring):
      // a 401/403 mid-pagination re-logs-in THIS agent only, never a
      // connector-wide `this.authenticate()` that would try (and possibly
      // fail) all 6 agents just to retry one request.
      const reauthenticate = () => this._loginAgent(agentUsername)

      this.log.debug({ agent: agentUsername, day, page }, 'Fetching transactions')

      const res  = await this._fetchWithRetry(url, buildOptions, `agent "${agentUsername}" day=${day} page=${page}`, reauthenticate)
      this._applySetCookies(agentUsername, res) // pick up a rotated session id before reading the body
      const body = await res.json()

      // `status !== 0` is Ganamos' own application-level error signal,
      // independent of the HTTP status code (plan Fase 0 punto 5). Its
      // `error_message` is upstream, free-form text — never logged or put in
      // a thrown message verbatim, since a session-related error could echo
      // back cookie/token fragments.
      if (!body || typeof body !== 'object' || typeof body.status !== 'number') {
        throw new Error(`Ganamos: unexpected response shape for agent "${agentUsername}" day ${day} page ${page} — expected {status, result}`)
      }
      if (body.status !== 0) {
        throw new Error(`Ganamos: application error (status=${body.status}) for agent "${agentUsername}" day ${day} page ${page}`)
      }

      const batch = body.result && Array.isArray(body.result.transfers) ? body.result.transfers : null
      if (batch === null) {
        throw new Error(`Ganamos: response for agent "${agentUsername}" day ${day} page ${page} is missing result.transfers`)
      }
      // Requested count=500 (PAGE_COUNT) explicitly; our "batch < count ends
      // pagination" rule depends on the API honoring it. A bigger batch means
      // it silently ignored the param — same guard ArgenBetConnector applies
      // to its own `limit` — so this refuses to paginate against an API that
      // isn't respecting the page size instead of mis-advancing past data.
      if (batch.length > PAGE_COUNT) {
        throw new Error(
          `Ganamos: API returned ${batch.length} rows for agent "${agentUsername}" day ${day} page ${page}, ` +
          `more than the requested count=${PAGE_COUNT} — refusing to paginate against an API that isn't honoring the count param.`
        )
      }

      collected.push(...batch)
      this.log.debug({ agent: agentUsername, day, batchSize: batch.length }, 'Batch received')

      if (batch.length < PAGE_COUNT) break // last page (spec: a batch smaller than count ends pagination)
      page++
    }

    return collected
  }

  /**
   * Per-record policy, same shape as ArgenBetConnector.normalizeTransactions:
   *
   *   DISCARD with a warning — ONLY for a transfer between two agents (both
   *   from_user/to_user resolve to a known Ganamos agent username), which is
   *   explicitly out of scope, the same exclusion the Excel importer already
   *   applies (`src/casino-import/excel.js`'s `agents` set).
   *
   *   THROW for anything else malformed on an otherwise in-scope record:
   *   missing id, missing/ambiguous agent side, missing operation/created_at/
   *   amount, unparsable created_at, invalid amount. A sync must never exit 0
   *   having silently lost an in-scope row.
   */
  async normalizeTransactions(rawData) {
    const normalized = []

    for (const raw of rawData) {
      const { __agentUsername: agente, ...item } = raw

      // `id` must be a string or a SAFE-integer number — a JS number above
      // Number.MAX_SAFE_INTEGER has already lost precision by the time
      // JSON parsing handed it to us (can't be recovered here), and an
      // object/boolean id would otherwise silently stringify into a bogus
      // "[object Object]"/"true" identity. Whitespace-only ("   ") is
      // rejected too, not just `null`/`''` — `String("   ").trim()` would
      // otherwise pass through as an apparently-valid empty-after-trim id.
      const rawId = item.id
      if (rawId == null || (typeof rawId !== 'string' && typeof rawId !== 'number')) {
        throw new Error(`Ganamos: transaction for agent "${agente}" has a missing or non-string/number id: ${JSON.stringify(rawId)}`)
      }
      if (typeof rawId === 'number' && !Number.isSafeInteger(rawId)) {
        throw new Error(`Ganamos: transaction for agent "${agente}" has an id outside safe integer range (already lost precision): ${rawId}`)
      }
      const source_id = String(rawId).trim()
      if (!source_id) {
        throw new Error(`Ganamos: transaction for agent "${agente}" is missing id`)
      }
      const id_rec = recordId(source_id) // same identity scheme as the Excel importer

      // from_user/to_user are STRINGS per plan Fase 0 punto 5 — not coerced
      // from arbitrary types, which would silently turn e.g. an object into
      // the literal player username "[object Object]".
      const fromUser = typeof item.from_user === 'string' ? item.from_user.trim() : ''
      const toUser   = typeof item.to_user === 'string' ? item.to_user.trim() : ''
      if (!fromUser || !toUser) {
        throw new Error(`Ganamos: transaction id=${source_id} for agent "${agente}" is missing from_user/to_user`)
      }

      const agenteLower = String(agente).toLowerCase()
      const fromIsAgent  = fromUser.toLowerCase() === agenteLower
      const toIsAgent    = toUser.toLowerCase() === agenteLower
      if (fromIsAgent === toIsAgent) {
        // Both sides are the requesting agent, or neither is — either way this
        // is malformed for a request made from that agent's own session.
        throw new Error(
          `Ganamos: transaction id=${source_id} has an ambiguous/missing agent side ` +
          `(from_user="${fromUser}", to_user="${toUser}", agent="${agente}")`
        )
      }
      const username = fromIsAgent ? toUser : fromUser

      if (this._isKnownAgentUsername(username)) {
        this.log.warn({ agent: agente, id: source_id, player: username }, 'Ganamos: discarding transaction — transfer between agents, out of scope (same exclusion as the Excel importer)')
        continue
      }

      if (item.operation == null || item.operation === '') {
        throw new Error(`Ganamos: transaction id=${source_id} for player "${username}" is missing operation`)
      }
      const opNumber = Number(item.operation)
      if (!Number.isFinite(opNumber)) {
        throw new Error(`Ganamos: transaction id=${source_id} for player "${username}" has a non-numeric operation: ${JSON.stringify(item.operation)}`)
      }
      const tipo = opNumber === 0 ? 'carga' : 'retiro' // operation === 0 -> deposit, everything else -> withdrawal (plan)

      if (item.created_at == null || item.created_at === '') {
        throw new Error(`Ganamos: transaction id=${source_id} for player "${username}" is missing created_at`)
      }
      const fecha_hora_utc = toUtcIso(item.created_at)
      if (!fecha_hora_utc || isNaN(Date.parse(fecha_hora_utc))) {
        throw new Error(`Ganamos: transaction id=${source_id} for player "${username}" has an unparsable created_at: ${JSON.stringify(item.created_at)}`)
      }
      const fecha = utcToLocalDate(fecha_hora_utc)

      if (item.amount == null || item.amount === '') {
        throw new Error(`Ganamos: transaction id=${source_id} for player "${username}" has no amount`)
      }
      // Strict on purpose: `Number(item.amount)` alone would accept
      // `true` (-> 1), a whitespace-only string (-> 0, NOT an error), an
      // exponent notation, or a value with more than 2 decimals — quietly
      // fabricating or corrupting a monto before `validateAmount` ever sees
      // it. Only a finite JS number, or a string matching a plain signed
      // decimal with at most 2 decimal places, is accepted.
      const parsedAmount = parseStrictAmount(item.amount)
      if (parsedAmount === null) {
        throw new Error(`Ganamos: transaction id=${source_id} for player "${username}" has a non-numeric amount: ${JSON.stringify(item.amount)}`)
      }
      const absAmount = Math.abs(parsedAmount)
      let monto
      try {
        monto = validateAmount(absAmount) // D3: pesos con centavos, sin redondear
      } catch (e) {
        throw new Error(`Ganamos: transaction id=${source_id} for player "${username}" has an invalid amount (${e.message}): ${JSON.stringify(item.amount)}`)
      }

      normalized.push({
        id_rec,
        source_id,
        username,
        agente,
        tipo,
        monto,
        fecha,
        fecha_hora_utc,
        raw_detalles: item.note ? String(item.note) : tipo,
      })
    }

    return normalized
  }

  _isKnownAgentUsername(username) {
    const lower = String(username).toLowerCase()
    return Object.keys(this.agentIds).some(agent => agent.toLowerCase() === lower)
  }

  /**
   * Warns when the last successful sync for an agent is older than 7 days
   * (plan Fase 3: detail is only retained ~60 days upstream — anything that
   * falls out of the sync cadence is lost for good, not just delayed).
   *
   * `casino_sync_runs` (the table that will hold real per-agent last-sync
   * timestamps) does not exist yet — that's Fase 4. This method takes the
   * timestamp as a plain argument instead of querying anything itself, so
   * Fase 4 can wire it to a real query without touching this connector, and
   * tests can exercise the boundary with injectable timestamps instead of a
   * live clock.
   *
   * @param {string} agentUsername
   * @param {Date|string|null} lastSuccessfulSyncAt
   * @param {Date} [now] injectable for tests — defaults to the real clock
   */
  checkStaleSync(agentUsername, lastSuccessfulSyncAt, now = new Date()) {
    if (!lastSuccessfulSyncAt) return
    const last = lastSuccessfulSyncAt instanceof Date ? lastSuccessfulSyncAt : new Date(lastSuccessfulSyncAt)
    if (isNaN(last.getTime())) return

    const diffDays = (now.getTime() - last.getTime()) / 86_400_000
    if (diffDays > STALE_SYNC_DAYS) {
      this.log.warn(
        { agent: agentUsername, lastSuccessfulSyncAt: last.toISOString(), diffDays: Math.floor(diffDays) },
        `Ganamos: last successful sync for agent "${agentUsername}" is older than ${STALE_SYNC_DAYS} days — ` +
        'detail is only retained ~60 days upstream, this window may already be partially unrecoverable'
      )
    }
  }

  async healthCheck() {
    const [agentUsername] = Object.keys(this.agentIds)
    const agentId          = this.agentIds[agentUsername]
    try {
      if (!this._hasSession(agentUsername)) {
        await this._loginAgent(agentUsername)
      }
      const today = new Date().toISOString().slice(0, 10)
      const url   = buildUrl(this.baseUrl, this.config.endpoint, agentId, `${today}T00:00:00`, `${addOneDay(today)}T00:00:00`, 0, PAGE_COUNT)

      const res = await fetch(url, {
        headers: {
          'Cookie':  this._cookieHeader(agentUsername),
          'Accept':  'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      })
      const healthy = res.status < 500
      if (healthy) {
        this.log.info({ status: res.status }, 'Health check passed')
      } else {
        this.log.warn({ status: res.status }, 'Health check failed — server error')
      }
      return healthy
    } catch (err) {
      this.log.warn({ error: err.message }, 'Health check failed')
      return false
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function buildUrl(baseUrl, endpoint, agentId, dateFrom, dateTo, page, count) {
  // Params fixed EXACTLY as docs/ganamos-export-consola.js / plan Fase 0
  // punto 5 — do not "clean up" the naming, the upstream API is picky about
  // which combination returns rows vs. period totals (transfers_only).
  const params = new URLSearchParams()
  params.set('date_from', dateFrom)
  params.set('date_to', dateTo)
  params.set('username', '')
  params.set('role', '0')
  params.set('is_direct_structure', 'false')
  params.set('is_higher_transaction_only', 'false')
  params.set('is_deposit_transfers', 'true')
  params.set('is_withdrawal_transfers', 'true')
  params.set('is_bonus_deposits', 'false')
  params.set('transfers_only', 'true')
  params.set('page', String(page))
  params.set('count', String(count))
  return `${baseUrl}${endpoint}/${agentId}/payment/history/?${params}`
}

/**
 * `created_at` comes back naive — no zone suffix — but IS UTC (plan Fase 0
 * punto 5, confirmed by the operator). Appending "Z" before handing it to any
 * Date-based helper makes that explicit instead of relying on the host
 * process's TZ (which `new Date("...")` without a suffix would otherwise use,
 * silently shifting every timestamp on a host not running in UTC).
 */
function toUtcIso(rawCreatedAt) {
  const s = String(rawCreatedAt)
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)
  const d = new Date(hasZone ? s : `${s}Z`)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}

/** `YYYY-MM-DD` AND a real calendar date (rejects e.g. 2026-02-30). */
function isValidCalendarDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/**
 * Ganamos never accepts a range above 24h for this endpoint (plan Fase 0
 * punto 5) — expands [desde, hasta] into one entry per calendar day,
 * inclusive on both ends, so `fetchTransactions` always issues one request
 * window per day, never a multi-day range. Fase 4 will only ever pass this
 * plain `YYYY-MM-DD` days (Ganamos' own incremental checkpoint is "today",
 * per the plan — never a sub-day timestamp), so both bounds are validated as
 * real calendar dates up front rather than trusted as opaque strings.
 */
function buildDayWindows(desde, hasta) {
  if (!isValidCalendarDate(desde)) throw new Error(`Ganamos: invalid desde date: ${JSON.stringify(desde)} (expected YYYY-MM-DD, a real calendar date)`)
  if (!isValidCalendarDate(hasta)) throw new Error(`Ganamos: invalid hasta date: ${JSON.stringify(hasta)} (expected YYYY-MM-DD, a real calendar date)`)
  if (desde > hasta) {
    throw new Error(`Ganamos: invalid date range — desde (${desde}) is after hasta (${hasta})`)
  }

  const days = []
  let cursor = desde
  while (cursor <= hasta) {
    days.push(cursor)
    cursor = addOneDay(cursor)
  }
  return days
}

/**
 * Strict amount parser (see normalizeTransactions() for why `Number(x)`
 * alone is unsafe here): accepts a finite JS number as-is, or a string that
 * is exactly an optionally-signed decimal with at most 2 fractional digits
 * (no exponent, no thousands separators, no surrounding text) — trimmed
 * once, never routed through `Number()` before this regex validates its
 * shape. Returns `null` for anything else, including booleans, objects,
 * whitespace-only strings (`Number('   ') === 0`, which would otherwise
 * fabricate a fake zero-value transaction), and NaN/Infinity.
 */
function parseStrictAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(trimmed)) return null
  return Number(trimmed)
}

/**
 * Parses a single `Set-Cookie` response header LINE (not the comma-joined
 * `headers.get('set-cookie')` form — callers must use `getSetCookie()` to
 * get lines un-joined, since a cookie's own `Expires` attribute contains a
 * comma that a naive split would corrupt). Returns `null` for a line with no
 * parseable `name=value` pair. `expired` is true when `Max-Age` is `<= 0` or
 * `Expires` parses to a point in the past — the two ways a server signals
 * "delete this cookie".
 */
function parseSetCookie(line) {
  const parts = String(line).split(';')
  const first = parts[0]
  const eq = first.indexOf('=')
  if (eq <= 0) return null
  const name  = first.slice(0, eq).trim()
  const value = first.slice(eq + 1).trim()
  if (!name) return null

  let expired = false
  for (const attr of parts.slice(1)) {
    const eqIdx = attr.indexOf('=')
    const attrName  = (eqIdx === -1 ? attr : attr.slice(0, eqIdx)).trim().toLowerCase()
    const attrValue = (eqIdx === -1 ? ''   : attr.slice(eqIdx + 1)).trim()
    if (attrName === 'max-age' && Number(attrValue) <= 0) expired = true
    if (attrName === 'expires') {
      const t = Date.parse(attrValue)
      if (!isNaN(t) && t <= Date.now()) expired = true
    }
  }
  return { name, value, expired }
}

module.exports = { GanamosConnector, ALLOWED_AGENT_IDS, buildDayWindows }
