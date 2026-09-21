'use strict'

const { createLogger } = require('../../lib/logger')

const BATCH_SIZE = 500

class BaseCasinoConnector {
  constructor(config, pool) {
    if (new.target === BaseCasinoConnector) {
      throw new Error(
        'BaseCasinoConnector is abstract — instantiate a concrete subclass instead'
      )
    }
    this._validateConfig(config)
    this.config = config
    this.pool   = pool
    this.log    = createLogger({ platform: config.name })
  }

  async authenticate() {}

  async healthCheck() {
    throw new Error(`${this.constructor.name} must implement healthCheck()`)
  }

  async fetchTransactions(agentUsername, startDate, endDate) {
    throw new Error(`${this.constructor.name} must implement fetchTransactions()`)
  }

  async normalizeTransactions(rawData) {
    throw new Error(`${this.constructor.name} must implement normalizeTransactions()`)
  }

  /**
   * D1 fix (H1): casino_players is a RECOMPUTED projection of casino_transactions,
   * never an accumulator. Re-running this — for the same range, the same agent,
   * or after the player moved to a different agent — always writes the same
   * totals (SET x = EXCLUDED.x, never `+=`). This replaces the old
   * aggregate()+upsertPlayers() pair, which summed EXCLUDED into the existing
   * row and corrupted totals on re-sync (plan H1).
   *
   * D2 fix (H2/H3): keyed by (platform, username_lower) — the same username on
   * two platforms is two independent rows, not one merged total.
   *
   * Correctness notes (fixed after coordinator review of the first version):
   *  - Scoped by (platform, username), NOT by agente. A player who changes
   *    agente within the same platform must have ALL of their history
   *    re-aggregated, not just the slice under whichever agente is being
   *    synced right now — filtering by agente alone silently dropped the other
   *    agente's totals on the next sync. `agente` on the row is instead derived
   *    deterministically from the player's most recent transaction.
   *  - The SUM/COUNT/MIN/MAX/tie-break all run inside a single Postgres
   *    INSERT ... SELECT — monto (NUMERIC(20,2)) is never parsed into a JS
   *    Number for persistence, so there is no float rounding on totals.
   *  - fecha_primera/fecha_ultima only consider tipo='carga' (deposits), same
   *    convention as migration 126's casino_segmentation_players view: a
   *    withdrawal must not make an inactive player look freshly active.
   *
   * @param {{username: string}[]} normalizedTxs  the batch just normalized for
   *   this sync call — only these players need recomputing (their totals are
   *   the only ones that could have changed).
   */
  async recomputePlayers(normalizedTxs) {
    const platform = this.config.name
    const usernamesLower = [...new Set(
      (normalizedTxs ?? [])
        .map(tx => tx.username)
        .filter(Boolean)
        .map(u => String(u).toLowerCase()),
    )]
    if (!usernamesLower.length) return 0

    const result = await this.pool.query(
      `INSERT INTO casino_players
         (username, agente, platform, total_cargas, total_retiros, cant_cargas, cant_retiros, fecha_primera, fecha_ultima)
       SELECT
         (array_agg(username ORDER BY COALESCE(fecha_hora_utc, fecha::timestamptz) DESC, id DESC))[1] AS username,
         (array_agg(agente   ORDER BY COALESCE(fecha_hora_utc, fecha::timestamptz) DESC, id DESC))[1] AS agente,
         $1::text AS platform,
         COALESCE(SUM(monto) FILTER (WHERE tipo = 'carga'),  0)::numeric(20,2) AS total_cargas,
         COALESCE(SUM(monto) FILTER (WHERE tipo = 'retiro'), 0)::numeric(20,2) AS total_retiros,
         COUNT(*) FILTER (WHERE tipo = 'carga')::int  AS cant_cargas,
         COUNT(*) FILTER (WHERE tipo = 'retiro')::int AS cant_retiros,
         MIN(fecha) FILTER (WHERE tipo = 'carga') AS fecha_primera,
         MAX(fecha) FILTER (WHERE tipo = 'carga') AS fecha_ultima
       FROM casino_transactions
       WHERE platform = $1
         AND username <> agente
         AND LOWER(username) = ANY($2::text[])
       GROUP BY LOWER(username)
       ON CONFLICT (platform, username_lower) DO UPDATE SET
         agente        = EXCLUDED.agente,
         total_cargas  = EXCLUDED.total_cargas,
         total_retiros = EXCLUDED.total_retiros,
         cant_cargas   = EXCLUDED.cant_cargas,
         cant_retiros  = EXCLUDED.cant_retiros,
         fecha_primera = EXCLUDED.fecha_primera,
         fecha_ultima  = EXCLUDED.fecha_ultima,
         updated_at    = NOW()`,
      [platform, usernamesLower],
    )
    return result.rowCount ?? 0
  }

  async insertTransactions(agente, normalizedTxs) {
    if (!normalizedTxs.length) return 0

    const platform  = this.config.name
    const withId    = []
    const withoutId = []

    for (const tx of normalizedTxs) {
      const row = [tx.fecha, tx.fecha_hora_utc, agente, tx.username, tx.tipo, tx.monto, tx.raw_detalles, platform]
      if (tx.id_rec) {
        withId.push([tx.id_rec, ...row])
      } else {
        withoutId.push(row)
      }
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      let inserted = 0
      inserted += await this._batchInsertWithId(withId, client)
      inserted += await this._batchInsertWithoutId(withoutId, client)

      await client.query('COMMIT')
      this.log.debug({ agent: agente, inserted }, 'Transaction committed')
      return inserted
    } catch (err) {
      await client.query('ROLLBACK')
      this.log.error({ agent: agente, err: err.message }, 'Transaction rolled back')
      throw err
    } finally {
      client.release()
    }
  }

  async syncAgent(agente, desde, hasta) {
    const startMs = Date.now()
    this.log.info({ agent: agente, from: desde, to: hasta }, 'Sync started')

    // D1: the incremental sync only ever WRITES casino_transactions (idempotent
    // via the unique indexes below). casino_players is then fully recomputed
    // from that table for this agent — never incremented from the fetched batch.
    const rawTxs          = await this.fetchTransactions(agente, desde, hasta)
    const normalizedTxs   = await this.normalizeTransactions(rawTxs)
    const insertedTxCount = await this.insertTransactions(agente, normalizedTxs)
    const playerCount     = await this.recomputePlayers(normalizedTxs)

    this.log.info({
      agent:          agente,
      txFetched:      rawTxs.length,
      txNormalized:   normalizedTxs.length,
      playersUpdated: playerCount,
      txInserted:     insertedTxCount,
      durationMs:     Date.now() - startMs,
    }, 'Sync completed')

    return { txCount: rawTxs.length, playerCount, insertedTxCount }
  }

  async _batchInsertWithId(rows, client) {
    let inserted = 0
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk  = rows.slice(i, i + BATCH_SIZE)
      const values = chunk.map((_, j) => {
        const b = j * 9
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9})`
      }).join(',')
      const result = await client.query(
        `INSERT INTO casino_transactions
           (id_rec, fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles, platform)
         VALUES ${values}
         ON CONFLICT (platform, id_rec) WHERE id_rec IS NOT NULL AND platform IS NOT NULL DO UPDATE
           SET fecha_hora_utc = EXCLUDED.fecha_hora_utc
           WHERE casino_transactions.fecha_hora_utc IS NULL`,
        chunk.flat(),
      )
      inserted += result.rowCount ?? 0
    }
    return inserted
  }

  async _batchInsertWithoutId(rows, client) {
    let inserted = 0
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk  = rows.slice(i, i + BATCH_SIZE)
      const values = chunk.map((_, j) => {
        const b = j * 8
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`
      }).join(',')
      const result = await client.query(
        `INSERT INTO casino_transactions
           (fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles, platform)
         VALUES ${values}
         ON CONFLICT (platform, fecha, lower(username), tipo, monto, agente) WHERE id_rec IS NULL AND platform IS NOT NULL DO UPDATE
           SET fecha_hora_utc = EXCLUDED.fecha_hora_utc
           WHERE casino_transactions.fecha_hora_utc IS NULL`,
        chunk.flat(),
      )
      inserted += result.rowCount ?? 0
    }
    return inserted
  }

  _validateEnvVars(varNames) {
    const missing = varNames.filter(name => !process.env[name]?.trim())
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variable(s) for platform "${this.config.name}": ${missing.join(', ')}`
      )
    }
  }

  /**
   * `options` may be a plain fetch-options object OR a zero-arg factory that
   * builds one fresh per attempt. Connectors should pass a factory whenever the
   * headers embed credentials that authenticate() can refresh (H11) — a static
   * object would keep resending the stale token even after re-auth succeeds.
   */
  async _fetchWithRetry(url, options, context = '') {
    const MAX_ATTEMPTS = 4

    let lastError
    let reauthUsed = false
    let attempt    = 1

    while (attempt <= MAX_ATTEMPTS) {
      const opts = typeof options === 'function' ? options() : options

      try {
        const res = await fetch(url, opts)

        if (res.status === 401 || res.status === 403) {
          // H11: a 401/403 mid-run is very often just an expired token
          // (confirmed for Argenbet's short-TTL JWT, and Zeus/Bet30's 24-48h
          // tokens) — not a genuine permission failure. Re-authenticate() and
          // retry EXACTLY once with rebuilt headers; this retry does not
          // consume one of the MAX_ATTEMPTS slots, so it always gets its
          // chance even if the 401 happens on the last normal attempt. If it
          // fails again, treat it as fatal like any other 4xx — no infinite
          // loop, no silent data loss.
          if (!reauthUsed) {
            reauthUsed = true
            this.log.warn({ status: res.status, context }, 'Auth error — re-authenticating and retrying once')
            await this.authenticate()
            continue
          }
          throw Object.assign(
            new Error(`HTTP ${res.status} (non-retriable client error)`),
            { nonRetriable: true },
          )
        }

        if (res.status >= 400 && res.status < 500) {
          throw Object.assign(
            new Error(`HTTP ${res.status} (non-retriable client error)`),
            { nonRetriable: true },
          )
        }

        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        return res

      } catch (err) {
        if (err.nonRetriable) throw err

        lastError = err

        if (attempt < MAX_ATTEMPTS) {
          const delayMs = 1000 * Math.pow(2, attempt - 1)
          this.log.warn({
            attempt,
            maxAttempts: MAX_ATTEMPTS,
            delayMs,
            error:       err.message,
            context,
          }, 'Fetch failed, retrying')
          console.warn(
            `[${this.config.name}] Retry ${attempt}/${MAX_ATTEMPTS - 1} for ${context} — ` +
            `Error: ${err.message}. Retrying in ${delayMs / 1000}s...`
          )
          await new Promise(r => setTimeout(r, delayMs))
        }

        attempt++
      }
    }

    throw new Error(
      `[${this.config.name}] All ${MAX_ATTEMPTS} attempts failed for ${context}: ${lastError.message}`
    )
  }

  _validateConfig(config) {
    const required = ['name', 'type', 'baseUrl', 'endpoint']
    for (const field of required) {
      if (!config[field]) {
        throw new Error(`Platform config "${config.name ?? '?'}" is missing required field: "${field}"`)
      }
    }
  }
}

module.exports = { BaseCasinoConnector }