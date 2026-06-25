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

  aggregate(normalizedTxs) {
    const map = new Map()

    for (const tx of normalizedTxs) {
      const { username, agente, monto = 0, tipo, fecha } = tx
      if (!username || !agente) continue

      if (!map.has(username)) {
        map.set(username, {
          username,
          agente,
          total_cargas:  0,
          total_retiros: 0,
          cant_cargas:   0,
          cant_retiros:  0,
          fecha_primera: null,
          fecha_ultima:  null,
        })
      }

      const player = map.get(username)

      if (tipo === 'carga') {
        player.total_cargas += monto
        player.cant_cargas++
      } else if (tipo === 'retiro') {
        player.total_retiros += monto
        player.cant_retiros++
      }

      if (fecha) {
        if (!player.fecha_primera || fecha < player.fecha_primera) player.fecha_primera = fecha
        if (!player.fecha_ultima  || fecha > player.fecha_ultima)  player.fecha_ultima  = fecha
      }
    }

    return [...map.values()]
  }

  async upsertPlayers(players) {
    if (!players.length) return 0

    const client = await this.pool.connect()
    try {
      for (const p of players) {
        await client.query(
          `INSERT INTO casino_players
             (username, agente, platform, total_cargas, total_retiros, cant_cargas, cant_retiros, fecha_primera, fecha_ultima)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (username_lower) DO UPDATE SET
             agente        = EXCLUDED.agente,
             platform      = COALESCE(EXCLUDED.platform, casino_players.platform),
             total_cargas  = casino_players.total_cargas  + EXCLUDED.total_cargas,
             total_retiros = casino_players.total_retiros + EXCLUDED.total_retiros,
             cant_cargas   = casino_players.cant_cargas   + EXCLUDED.cant_cargas,
             cant_retiros  = casino_players.cant_retiros  + EXCLUDED.cant_retiros,
             fecha_primera = LEAST(casino_players.fecha_primera, EXCLUDED.fecha_primera),
             fecha_ultima  = GREATEST(casino_players.fecha_ultima, EXCLUDED.fecha_ultima)`,
          [
            p.username,      p.agente,        p.platform ?? null,
            p.total_cargas,  p.total_retiros,
            p.cant_cargas,   p.cant_retiros,
            p.fecha_primera, p.fecha_ultima,
          ],
        )
      }
      return players.length
    } finally {
      client.release()
    }
  }

  async insertTransactions(agente, normalizedTxs) {
    if (!normalizedTxs.length) return 0

    const withId    = []
    const withoutId = []

    for (const tx of normalizedTxs) {
      const row = [tx.fecha, tx.fecha_hora_utc, agente, tx.username, tx.tipo, tx.monto, tx.raw_detalles]
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

    const rawTxs          = await this.fetchTransactions(agente, desde, hasta)
    const normalizedTxs   = await this.normalizeTransactions(rawTxs)
    const players         = this.aggregate(normalizedTxs)
    const playerCount     = await this.upsertPlayers(players)
    const insertedTxCount = await this.insertTransactions(agente, normalizedTxs)

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
        const b = j * 8
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`
      }).join(',')
      const result = await client.query(
        `INSERT INTO casino_transactions
           (id_rec, fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles)
         VALUES ${values}
         ON CONFLICT (id_rec) WHERE id_rec IS NOT NULL DO UPDATE
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
        const b = j * 7
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`
      }).join(',')
      const result = await client.query(
        `INSERT INTO casino_transactions
           (fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles)
         VALUES ${values}
         ON CONFLICT (fecha, username, tipo, monto, agente) WHERE id_rec IS NULL DO UPDATE
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

  async _fetchWithRetry(url, options, context = '') {
    const MAX_ATTEMPTS = 4

    let lastError

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, options)

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