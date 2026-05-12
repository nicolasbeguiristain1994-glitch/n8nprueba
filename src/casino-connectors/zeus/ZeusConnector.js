'use strict'

const { BaseCasinoConnector } = require('../base/BaseCasinoConnector')

/**
 * Connector for the Zeus Casino platform.
 *
 * API base: ZEUS_API_BASE || config.baseUrl  (https://local-admin2.zeuscasino.fun)
 * Endpoint: GET /api/records/movimiento-fichas
 * Auth:     X-Api-Key + X-Player-Token headers
 *
 * Transaction types are inferred from the `detalles` field:
 *   - contains "carga"   → tipo = 'carga'
 *   - contains "retiro"  → tipo = 'retiro'
 *   - contains "indirecto" → excluded (capital transfer between agents)
 */
class ZeusConnector extends BaseCasinoConnector {
  constructor(config, pool) {
    super(config, pool)

    // Fail fast: surface missing credentials before any API call is attempted
    this._validateEnvVars([config.apiKeyEnvVar, config.playerTokenEnvVar])

    // env var ZEUS_API_BASE overrides the base URL defined in config (optional)
    this.baseUrl     = (process.env[config.baseUrlEnvVar] || config.baseUrl).trim()
    this.apiKey      = process.env[config.apiKeyEnvVar].trim()
    this.playerToken = process.env[config.playerTokenEnvVar].trim()
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

      const fechaDate    = this._utcToArgDate(fecha)
      const fechaHoraUtc = this._extractUtcTimestamp(fecha)
      if (!fechaDate) continue

      normalized.push({
        id_rec,
        username,
        agente,
        tipo,
        monto:          Math.round(Math.abs(valor)),
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
      this.log.warn({ error: err.message }, 'Health check failed — network error')
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

module.exports = { ZeusConnector }
