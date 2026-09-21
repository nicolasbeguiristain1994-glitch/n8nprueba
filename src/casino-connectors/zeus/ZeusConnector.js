'use strict'

const { BaseCasinoConnector } = require('../base/BaseCasinoConnector')
const { fmtDate, addOneDay, utcToLocalDate, extractUtcTimestamp } = require('../shared/dateHelpers')

/**
 * Connector for the Zeus Casino platform.
 *
 * API base: ZEUS_API_BASE || config.baseUrl  (https://local-admin2.zeuscasino.fun)
 * Endpoint: GET /api/records/movimiento-fichas
 * Auth:     X-Api-Key + X-Player-Token headers
 *
 * Token refresh (preferred): set ZEUS_ADMIN_USER + ZEUS_ADMIN_PASSWORD in env.
 *   authenticate() will call the OAuth2 password-grant endpoint on startup and
 *   obtain a fresh token automatically — no manual rotation needed.
 *
 * Token static (fallback): set ZEUS_PLAYER_TOKEN instead. The token expires
 *   every 24–48 h and must be updated manually in Railway.
 *
 * Transaction types are inferred from the `detalles` field:
 *   - contains "carga"   → tipo = 'carga'
 *   - contains "retiro"  → tipo = 'retiro'
 *   - contains "indirecto" → excluded (capital transfer between agents)
 */
class ZeusConnector extends BaseCasinoConnector {
  constructor(config, pool) {
    super(config, pool)

    this.baseUrl = (process.env[config.baseUrlEnvVar] || config.baseUrl).trim()

    this._validateEnvVars([config.apiKeyEnvVar])
    this.apiKey = process.env[config.apiKeyEnvVar].trim()

    const hasAutoLogin =
      config.adminUserEnvVar     && process.env[config.adminUserEnvVar]?.trim() &&
      config.adminPasswordEnvVar && process.env[config.adminPasswordEnvVar]?.trim()

    if (!hasAutoLogin) {
      // Fall back to static token — must be set manually in Railway
      this._validateEnvVars([config.playerTokenEnvVar])
      this.playerToken = process.env[config.playerTokenEnvVar].trim()
    } else {
      // Will be set by authenticate() before any API call
      this.playerToken = null
    }
  }

  /**
   * Logs in to the casino panel and obtains a fresh X-Player-Token.
   * Called once by the sync orchestrator before the agent loop starts.
   * No-op if ZEUS_ADMIN_USER / ZEUS_ADMIN_PASSWORD are not configured
   * (falls back to the static ZEUS_PLAYER_TOKEN).
   */
  async authenticate() {
    const adminUser     = process.env[this.config.adminUserEnvVar]?.trim()
    const adminPassword = process.env[this.config.adminPasswordEnvVar]?.trim()

    if (!adminUser || !adminPassword || !this.config.loginUrl) return

    const params = new URLSearchParams({
      username:      adminUser,
      password:      adminPassword,
      client_id:     this.config.loginClientId,
      client_secret: this.config.loginClientSecret,
      grant_type:    'password',
      source:        'pn',
    })

    const url = `${this.config.loginUrl}?${params}`

    // Neither the request URL (query-string auth, includes the password) nor a
    // raw response body should ever reach a log line or a rethrown Error — both
    // propagate up through sync-casino-players-live.js's top-level error logger.
    // `redact()` strips any literal occurrence of the known secrets first.
    const secrets = [adminPassword, this.config.loginClientSecret].filter(Boolean)
    const redact  = (text) => secrets.reduce((t, s) => t.split(s).join('[REDACTED]'), String(text ?? ''))

    let res
    try {
      res = await fetch(url, {
        headers: {
          'Accept':  'application/json, text/plain, */*',
          'Origin':  this.config.loginPanelOrigin,
          'Referer': `${this.config.loginPanelOrigin}/`,
        },
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      throw new Error(`${this.config.name} auto-login network error: ${redact(err.message)}`)
    }

    if (!res.ok) {
      let errBody = ''
      try { errBody = await res.text() } catch (_) {}
      throw new Error(`${this.config.name} auto-login failed: HTTP ${res.status} — ${redact(errBody).slice(0, 300)}`)
    }

    const body  = await res.json()
    const token = body.access_token
    if (!token) {
      throw new Error(`${this.config.name} auto-login: response missing access_token`)
    }

    this.playerToken = token
    this.log.info({ platform: this.config.name }, 'Player token refreshed via auto-login')
  }

  // ── API ───────────────────────────────────────────────────────────────────

  async fetchTransactions(agentUsername, startDate, endDate) {
    const params = new URLSearchParams({
      username:  agentUsername,
      startDate: fmtDate(startDate),
      // Zeus uses exclusive end dates — pass the day after `endDate` (same as the UI panel)
      endDate:   fmtDate(addOneDay(endDate)),
      timezone:  this.config.timezone,
    })

    const url = `${this.baseUrl}${this.config.endpoint}?${params}`

    this.log.debug({ agent: agentUsername, endpoint: this.config.endpoint, from: startDate, to: endDate }, 'Fetching transactions')

    // Built as a factory (not a static object) so that a mid-run re-authenticate()
    // (see BaseCasinoConnector._fetchWithRetry, H11) picks up the refreshed
    // this.playerToken on retry instead of resending the stale one.
    const buildOptions = () => ({
      headers: {
        'X-Api-Key':      this.apiKey,
        'X-Player-Token': this.playerToken,
        'Accept':         'application/json, text/plain, */*',
        // Origin/Referer required by the Zeus API gateway
        'Origin':         'https://panel-skin5.zeuscasino.fun',
        'Referer':        'https://panel-skin5.zeuscasino.fun/',
      },
      signal: AbortSignal.timeout(60_000),
    })

    const res = await this._fetchWithRetry(url, buildOptions, `agent "${agentUsername}"`)

    const body  = await res.json()
    // Zeus response can be: array | { data } | { records } | { result }
    const items = Array.isArray(body) ? body : (body.data ?? body.records ?? body.result ?? [])

    this.log.debug({ agent: agentUsername, count: items.length }, 'Transactions received')
    return items
  }

  async normalizeTransactions(rawData) {
    const normalized = []

    for (const tx of rawData) {
      const {
        id:               id_rec           = null,
        username,
        creator_username: agente           = '',
        valor                              = 0,
        detalles                           = '',
        fecha,
      } = tx

      if (!username || !fecha) continue

      const dl = detalles.toLowerCase()

      // Capital transfers between agents are not player transactions
      if (dl.includes('indirecto')) continue

      const tipo = dl.includes('carga')   ? 'carga'
                 : dl.includes('retiro')  ? 'retiro'
                 : null
      if (!tipo) continue

      const fechaDate    = utcToLocalDate(fecha)
      const fechaHoraUtc = extractUtcTimestamp(fecha)
      if (!fechaDate) continue

      normalized.push({
        id_rec,
        username,
        agente,
        tipo,
        // D3: no redondear — Zeus/Bet30 no están garantizados a devolver siempre
        // enteros, y casino_transactions.monto es NUMERIC(20,2) (migración 126)
        // precisamente para no perder centavos. Math.abs sigue siendo necesario:
        // Zeus reporta retiros como valores negativos.
        monto:          Math.abs(Number(valor)),
        fecha:          fechaDate,
        fecha_hora_utc: fechaHoraUtc,
        raw_detalles:   detalles,
      })
    }

    return normalized
  }

  async healthCheck() {
    try {
      const today  = new Date().toISOString().substring(0, 10)
      const params = new URLSearchParams({
        username:  'health-check',
        startDate: fmtDate(today),
        endDate:   fmtDate(addOneDay(today)),
        timezone:  this.config.timezone,
      })
      const res = await fetch(
        `${this.baseUrl}${this.config.endpoint}?${params}`,
        {
          headers: {
            'X-Api-Key':      this.apiKey,
            'X-Player-Token': this.playerToken,
          },
          signal: AbortSignal.timeout(10_000),
        },
      )
      // Any response below 500 means the gateway is reachable
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

module.exports = { ZeusConnector }
