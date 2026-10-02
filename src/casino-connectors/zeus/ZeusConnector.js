'use strict'

const { BaseCasinoConnector, networkReason } = require('../base/BaseCasinoConnector')
const { SyncError } = require('../sync/sanitize')

// Business decision 2026-09-15: only Zeus counts standalone bono/bonos as a deposit.
// Unicode boundaries avoid treating abono, Josébono or bono_player as bonuses.
const BONUS_WORD_RE = /(?:^|[^\p{L}\p{M}\p{N}_])bonos?(?=$|[^\p{L}\p{M}\p{N}_])/iu

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
 *   - only for config.name === 'zeus': standalone "bono"/"bonos" → 'carga'
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
      // Solo el motivo controlado: el mensaje de fetch puede incluir la URL de
      // login, que lleva usuario, contraseña y client_secret en el query string.
      throw new Error(`${this.config.name} auto-login network error (${networkReason(err)})`)
    }

    if (!res.ok) {
      // No se lee el cuerpo: puede reflejar credenciales o datos de la cuenta.
      throw Object.assign(
        new Error(`${this.config.name} auto-login failed: HTTP ${res.status}`),
        { httpStatus: res.status },
      )
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
      startDate: this._fmtDate(startDate),
      // Zeus uses exclusive end dates — pass the day after `endDate` (same as the UI panel)
      endDate:   this._fmtDate(this._addOneDay(endDate)),
      timezone:  this.config.timezone,
    })

    const url = `${this.baseUrl}${this.config.endpoint}?${params}`

    this.log.debug({ agent: agentUsername, endpoint: this.config.endpoint, from: startDate, to: endDate }, 'Fetching transactions')

    const res = await this._fetchWithRetry(
      url,
      {
        headers: {
          'X-Api-Key':      this.apiKey,
          'X-Player-Token': this.playerToken,
          'Accept':         'application/json, text/plain, */*',
          // Origin/Referer required by the Zeus API gateway
          'Origin':         'https://panel-skin5.zeuscasino.fun',
          'Referer':        'https://panel-skin5.zeuscasino.fun/',
        },
        signal: AbortSignal.timeout(60_000),
      },
      `agent "${agentUsername}"`,
    )

    let body
    try {
      body = await res.json()
    } catch {
      // El mensaje de JSON.parse puede incluir un fragmento del cuerpo: no se usa.
      throw new SyncError('INVALID_RESPONSE',
        `${this.config.name} devolvió una respuesta que no es JSON para el agente ${agentUsername}.`)
    }

    const items = extractItems(body)
    if (!items) {
      // Un 200 con {error: ...}, {message: ...} o cualquier forma desconocida NO
      // es "cero movimientos": tratarlo como [] avanzaría el cursor sobre datos
      // que nunca se leyeron.
      throw new SyncError('INVALID_RESPONSE',
        `${this.config.name} devolvió un formato de respuesta desconocido para el agente ${agentUsername}.`)
    }

    this.log.debug({ agent: agentUsername, count: items.length }, 'Transactions received')
    return items
  }

  /**
   * Como normalizeTransactions, pero distingue:
   *   excluded — movimientos "indirecto" (capital entre agentes): exclusión esperada
   *   invalid  — filas sin username/fecha, con fecha ilegible o tipo no reconocido
   */
  async normalizeWithStats(rawData) {
    const rows = []
    let invalid  = 0
    let excluded = 0

    for (const tx of rawData) {
      const r = this._normalizeOne(tx)
      if (r.row)           rows.push(r.row)
      else if (r.excluded) excluded++
      else                 invalid++
    }

    return { rows, invalid, excluded }
  }

  async normalizeTransactions(rawData) {
    return (await this.normalizeWithStats(rawData)).rows
  }

  /** @returns {{row?: object, excluded?: boolean}} sin row ni excluded = inválida */
  _normalizeOne(tx) {
    if (!tx || typeof tx !== 'object') return {}

    const {
      id:               id_rec           = null,
      username,
      creator_username: agente           = '',
      valor                              = 0,
      detalles                           = '',
      fecha,
    } = tx

    if (!username || !fecha) return {}

    const detallesStr = typeof detalles === 'string' ? detalles : ''
    const dl = detallesStr.toLowerCase()

    // Capital transfers between agents are not player transactions
    if (dl.includes('indirecto')) return { excluded: true }

    const tipo = dl.includes('carga')   ? 'carga'
               : dl.includes('retiro')  ? 'retiro'
               // Sharing this API does not authorize sharing Zeus's bonus rule.
               : this.config.name === 'zeus' && BONUS_WORD_RE.test(detallesStr) ? 'carga'
               : null
    if (!tipo) return {}

    const fechaDate    = this._utcToArgDate(fecha)
    const fechaHoraUtc = this._extractUtcTimestamp(fecha)
    if (!fechaDate) return {}

    const monto = Math.round(Math.abs(Number(valor)))
    if (!Number.isFinite(monto)) return {}

    return {
      row: {
        id_rec,
        username,
        agente,
        tipo,
        monto,
        fecha:          fechaDate,
        fecha_hora_utc: fechaHoraUtc,
        raw_detalles:   detallesStr,
      },
    }
  }

  async healthCheck() {
    try {
      const today  = new Date().toISOString().substring(0, 10)
      const params = new URLSearchParams({
        username:  'health-check',
        startDate: this._fmtDate(today),
        endDate:   this._fmtDate(this._addOneDay(today)),
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
      this.log.warn({ reason: networkReason(err) }, 'Health check failed — network error')
      return false
    }
  }

  // ── Date helpers ──────────────────────────────────────────────────────────

  // Zeus API expects "YYYY-MM-DD HH:MM:SS" — URLSearchParams encodes space as +
  _fmtDate(d) {
    return `${d} 00:00:00`
  }

  // Adds one day to a YYYY-MM-DD string (noon UTC avoids DST edge cases)
  _addOneDay(dateStr) {
    const d = new Date(`${dateStr}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().substring(0, 10)
  }

  // Zeus returns UTC timestamps. Convert to Argentina local date (UTC−3, no DST).
  // A 22:00 ART transaction is 01:00 UTC next day — substring(0,10) on raw UTC is wrong.
  _utcToArgDate(fechaStr) {
    if (!fechaStr) return null
    const d = new Date(fechaStr)
    if (isNaN(d.getTime())) {
      return typeof fechaStr === 'string' ? fechaStr.substring(0, 10) : null
    }
    return new Date(d.getTime() - 3 * 3_600_000).toISOString().substring(0, 10)
  }

  // Returns a clean ISO UTC string only when the raw value has a time component.
  _extractUtcTimestamp(fechaStr) {
    if (!fechaStr) return null
    if (!fechaStr.includes('T') && !fechaStr.includes(' ')) return null
    const d = new Date(fechaStr)
    if (isNaN(d.getTime())) return null
    return d.toISOString()
  }
}

/**
 * Zeus responde array | { data } | { records } | { result }. Se acepta solo si
 * el contenido es efectivamente un array; cualquier otra forma devuelve null.
 */
function extractItems(body) {
  if (Array.isArray(body)) return body
  if (!body || typeof body !== 'object') return null
  for (const key of ['data', 'records', 'result']) {
    if (key in body) return Array.isArray(body[key]) ? body[key] : null
  }
  return null
}

module.exports = { ZeusConnector, extractItems }
