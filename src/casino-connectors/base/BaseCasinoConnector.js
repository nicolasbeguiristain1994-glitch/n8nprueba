'use strict'

const { createLogger } = require('../../lib/logger')
const { SyncError }    = require('../sync/sanitize')

const BATCH_SIZE = 500

// Espacio de claves para pg_advisory_xact_lock(ns, hashtext(username)).
// Serializa el recompute de un mismo jugador entre corridas concurrentes
// (p. ej. Zeus y Bet30 a la vez sobre un jugador que opera en las dos).
const PLAYER_LOCK_NAMESPACE = 7126

const BIGINT_MAX = '9223372036854775807'

/**
 * Normaliza el ID de transacción del casino a un BIGINT positivo en texto.
 *
 * Devuelve null (= "sin ID", va a la dedup por día) para null, vacío, 0,
 * negativos, decimales, no numéricos y valores fuera de rango. `0` en
 * particular no puede ser un ID: si se aceptara, todas las filas con id 0
 * colapsarían en una sola.
 */
function normalizeIdRec(value) {
  if (value === null || value === undefined) return null

  let s
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null
    s = String(value)
  } else if (typeof value === 'bigint') {
    s = value.toString()
  } else {
    s = String(value).trim()
  }

  if (!/^\d+$/.test(s)) return null
  const digits = s.replace(/^0+/, '')
  if (!digits) return null
  if (digits.length > BIGINT_MAX.length) return null
  if (digits.length === BIGINT_MAX.length && digits > BIGINT_MAX) return null
  return digits
}

/**
 * Motivo de un error de red en texto controlado: código de sistema (ECONNRESET…),
 * timeout, o el nombre de la clase. Nunca el mensaje, que puede traer la URL.
 */
function networkReason(err) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'timeout'
  const code = err?.cause?.code ?? err?.code
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code
  if (typeof err?.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name)) return err.name
  return 'desconocido'
}

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

  /** Plataforma con la que se etiquetan las filas de casino_transactions. */
  get platform() {
    return this.config.name
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
   * Normaliza y cuenta descartes.
   *
   *   excluded = filas descartadas a propósito (p. ej. movimientos entre agentes)
   *   invalid  = filas que no se pudieron interpretar → cobertura limitada
   *
   * Default conservador: toda fila que normalizeTransactions descarta sin
   * explicación cuenta como inválida. Las subclases que excluyen filas a
   * propósito deben sobrescribir este método (ver ZeusConnector).
   *
   * @returns {Promise<{rows: object[], invalid: number, excluded: number}>}
   */
  async normalizeWithStats(rawData) {
    const rows = await this.normalizeTransactions(rawData)
    return { rows, invalid: Math.max(0, rawData.length - rows.length), excluded: 0 }
  }

  /**
   * Prepara las transacciones normalizadas para escribirlas.
   *
   * - Normaliza el ID (ver normalizeIdRec) y recorta espacios del username.
   * - Deduplica dentro del lote: un mismo ID repetido en la respuesta haría
   *   fallar el INSERT ... ON CONFLICT DO UPDATE ("cannot affect row a second time").
   * - Cuenta honestamente lo que la dedup por día no puede distinguir: dos
   *   movimientos sin ID con igual fecha, jugador, tipo y monto colapsan en uno.
   *
   * @returns {{withId: object[], withoutId: object[], usernames: string[], stats: object, coverage: 'complete'|'limited'}}
   */
  prepareTransactions(normalizedTxs) {
    const withId    = new Map()
    const withoutId = new Map()
    const usernames = new Set()
    const stats = {
      normalized:         normalizedTxs.length,
      invalid:            0,
      withoutId:          0,
      duplicateIds:       0,
      collapsedWithoutId: 0,
    }

    for (const tx of normalizedTxs) {
      const username = typeof tx.username === 'string' ? tx.username.trim() : ''
      if (!username || !tx.fecha || (tx.tipo !== 'carga' && tx.tipo !== 'retiro')) {
        stats.invalid++
        continue
      }

      const row = { ...tx, username, id_rec: normalizeIdRec(tx.id_rec) }
      usernames.add(username.toLowerCase())

      if (row.id_rec) {
        if (withId.has(row.id_rec)) stats.duplicateIds++
        else withId.set(row.id_rec, row)
      } else {
        stats.withoutId++
        const key = `${row.fecha}|${username.toLowerCase()}|${row.tipo}|${row.monto}`
        if (withoutId.has(key)) stats.collapsedWithoutId++
        else withoutId.set(key, row)
      }
    }

    return {
      withId:    [...withId.values()],
      withoutId: [...withoutId.values()],
      usernames: [...usernames],
      stats,
      coverage:  stats.withoutId > 0 || stats.invalid > 0 ? 'limited' : 'complete',
    }
  }

  /**
   * Inserta las transacciones con la plataforma del conector, usando `client`
   * (sin manejar la transacción: la maneja persistSync).
   *
   * @returns {Promise<{inserted: number, updated: number}>}
   *   inserted = filas nuevas; updated = filas existentes a las que se completó
   *   fecha_hora_utc. Las repetidas sin cambios no cuentan en ninguno.
   */
  async writeTransactions(client, agente, prepared) {
    let inserted = 0
    let updated  = 0

    const withId = prepared.withId.map(tx => [
      this.platform, tx.id_rec, tx.fecha, tx.fecha_hora_utc ?? null,
      agente, tx.username, tx.tipo, tx.monto, tx.raw_detalles ?? null,
    ])
    const withoutId = prepared.withoutId.map(tx => [
      this.platform, tx.fecha, tx.fecha_hora_utc ?? null,
      agente, tx.username, tx.tipo, tx.monto, tx.raw_detalles ?? null,
    ])

    for (let i = 0; i < withId.length; i += BATCH_SIZE) {
      const r = await this._insertBatch(client, withId.slice(i, i + BATCH_SIZE), true)
      inserted += r.inserted
      updated  += r.updated
    }
    for (let i = 0; i < withoutId.length; i += BATCH_SIZE) {
      const r = await this._insertBatch(client, withoutId.slice(i, i + BATCH_SIZE), false)
      inserted += r.inserted
      updated  += r.updated
    }

    return { inserted, updated }
  }

  /**
   * Recalcula casino_players desde casino_transactions para los jugadores dados
   * y ASIGNA el resultado (no suma): correr el mismo rango N veces, o reintentar
   * tras un rollback, deja siempre los mismos totales.
   *
   * Semántica (se conserva la de la tabla actual, clave global por username):
   *   - Agrega TODAS las filas del jugador, de cualquier agente y plataforma,
   *     incluidas las históricas sin plataforma: no se pierde historial ajeno al
   *     rango sincronizado. Excluye filas con username = agente (movimientos
   *     entre agentes), igual que scripts/rebuild-casino-players-from-db.js.
   *   - agente/platform = los de la transacción más reciente del jugador.
   *   - No toca seg_monto, seg_actividad, labels ni ninguna otra columna.
   *   - D2 pendiente: un jugador con el mismo username en dos plataformas sigue
   *     siendo una sola fila (ver docs/PLAN-METRICAS-4-PLATAFORMAS.md §D2).
   *
   * Concurrencia: toma pg_advisory_xact_lock por jugador, en orden de clave,
   * ANTES del recompute. Con READ COMMITTED, la corrida que obtiene el lock en
   * segundo lugar ejecuta su SELECT después del COMMIT de la primera y ve sus
   * filas: la última proyección escrita siempre incluye ambas ingestas.
   *
   * @param {import('pg').PoolClient} client  cliente dentro de una transacción
   * @param {string[]} usernamesLower          usernames en minúscula
   * @returns {Promise<number>} jugadores insertados/actualizados
   */
  async recomputePlayers(client, usernamesLower) {
    if (!usernamesLower.length) return 0

    // El ORDER BY del SELECT externo fija el orden de evaluación de la función
    // (Postgres ≥ 9.6), así dos transacciones piden los locks en el mismo orden
    // y no pueden bloquearse mutuamente.
    await client.query(
      `SELECT pg_advisory_xact_lock($1, k)
       FROM (SELECT DISTINCT hashtext(u) AS k FROM unnest($2::text[]) AS u) keys
       ORDER BY k`,
      [PLAYER_LOCK_NAMESPACE, usernamesLower],
    )

    const result = await client.query(
      `WITH objetivo AS (
         SELECT DISTINCT u AS uname FROM unnest($1::text[]) AS u
       ),
       fuente AS (
         SELECT LOWER(ct.username) AS uname, ct.username, ct.agente, ct.platform,
                ct.tipo, ct.monto, ct.fecha, ct.fecha_hora_utc, ct.id
         FROM casino_transactions ct
         JOIN objetivo o ON LOWER(ct.username) = o.uname
         WHERE LOWER(ct.username) <> LOWER(ct.agente)
       ),
       agregado AS (
         SELECT uname,
                COALESCE(SUM(monto) FILTER (WHERE tipo = 'carga'),  0) AS total_cargas,
                COALESCE(SUM(monto) FILTER (WHERE tipo = 'retiro'), 0) AS total_retiros,
                COUNT(*) FILTER (WHERE tipo = 'carga')::int            AS cant_cargas,
                COUNT(*) FILTER (WHERE tipo = 'retiro')::int           AS cant_retiros,
                MIN(fecha) AS fecha_primera,
                MAX(fecha) AS fecha_ultima
         FROM fuente
         GROUP BY uname
       ),
       reciente AS (
         SELECT DISTINCT ON (uname) uname, username, agente, platform
         FROM fuente
         ORDER BY uname, fecha DESC, fecha_hora_utc DESC NULLS LAST, id DESC
       )
       INSERT INTO casino_players
         (username, agente, platform, total_cargas, total_retiros,
          cant_cargas, cant_retiros, fecha_primera, fecha_ultima)
       SELECT r.username, r.agente, r.platform, a.total_cargas, a.total_retiros,
              a.cant_cargas, a.cant_retiros, a.fecha_primera, a.fecha_ultima
       FROM agregado a
       JOIN reciente r USING (uname)
       ON CONFLICT (username_lower) DO UPDATE SET
         agente        = EXCLUDED.agente,
         platform      = COALESCE(EXCLUDED.platform, casino_players.platform),
         total_cargas  = EXCLUDED.total_cargas,
         total_retiros = EXCLUDED.total_retiros,
         cant_cargas   = EXCLUDED.cant_cargas,
         cant_retiros  = EXCLUDED.cant_retiros,
         fecha_primera = EXCLUDED.fecha_primera,
         fecha_ultima  = EXCLUDED.fecha_ultima,
         updated_at    = NOW()`,
      [usernamesLower],
    )

    return result.rowCount ?? 0
  }

  /**
   * Escribe transacciones y recalcula jugadores en UNA transacción.
   *
   * Hooks (reciben el mismo client, dentro de la transacción):
   *   - beforeWrite(client): validaciones que deben abortar antes de escribir.
   *   - afterWrite(client, written): registrar el resultado y mover el cursor
   *     de forma atómica con los datos.
   *
   * Cualquier error hace ROLLBACK de todo: no queda ingesta sin proyección ni
   * proyección sin ingesta, ni cursor movido sobre datos que no se guardaron.
   */
  async persistSync(agente, prepared, { beforeWrite, afterWrite } = {}) {
    const hasRows = prepared.withId.length > 0 || prepared.withoutId.length > 0
    if (!hasRows && !beforeWrite && !afterWrite) {
      return { inserted: 0, updated: 0, players: 0 }
    }

    const client = await this.pool.connect()
    let brokenClient

    try {
      await client.query('BEGIN')

      if (beforeWrite) await beforeWrite(client)
      await this._assertNoLegacyIdCollision(client, prepared)

      const { inserted, updated } = await this.writeTransactions(client, agente, prepared)
      const players = await this.recomputePlayers(client, prepared.usernames)
      const written = { inserted, updated, players }

      if (afterWrite) await afterWrite(client, written)

      await client.query('COMMIT')
      this.log.debug({ agent: agente, ...written }, 'Transaction committed')
      return written
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackErr) {
        // Conexión en estado desconocido: se descarta en vez de devolverla al pool.
        brokenClient = rollbackErr
      }
      this.log.error({ agent: agente, code: err.code }, 'Transaction rolled back')
      throw err
    } finally {
      client.release(brokenClient)
    }
  }

  /**
   * Pipeline completo de un agente y un rango: fetch → normalize → persistSync.
   * `hooks.afterWrite(client, summary)` recibe el resumen con contadores.
   */
  async syncAgent(agente, desde, hasta, hooks = {}) {
    const startMs        = Date.now()
    const fetchStartedAt = new Date()
    this.log.info({ agent: agente, from: desde, to: hasta }, 'Sync started')

    const rawTxs     = await this.fetchTransactions(agente, desde, hasta)
    const normalized = await this.normalizeWithStats(rawTxs)
    const prepared   = this.prepareTransactions(normalized.rows)

    // Filas que no se pudieron interpretar (en la normalización o al preparar):
    // el rango se procesó, pero no se puede afirmar que no falte nada.
    const txInvalid = normalized.invalid + prepared.stats.invalid
    const coverage  = prepared.coverage === 'limited' || txInvalid > 0 ? 'limited' : 'complete'

    const buildSummary = written => ({
      txCount:              rawTxs.length,
      txNormalized:         normalized.rows.length,
      insertedTxCount:      written.inserted,
      updatedTxCount:       written.updated,
      playerCount:          written.players,
      txWithoutId:          prepared.stats.withoutId,
      txDuplicateIds:       prepared.stats.duplicateIds,
      txCollapsedWithoutId: prepared.stats.collapsedWithoutId,
      txInvalid,
      txExcluded:           normalized.excluded,
      coverage,
      fetchStartedAt,
    })

    const written = await this.persistSync(agente, prepared, {
      beforeWrite: hooks.beforeWrite,
      afterWrite:  hooks.afterWrite
        ? (client, w) => hooks.afterWrite(client, buildSummary(w))
        : undefined,
    })

    const summary = buildSummary(written)
    this.log.info({
      agent:          agente,
      txFetched:      summary.txCount,
      txInserted:     summary.insertedTxCount,
      txWithoutId:    summary.txWithoutId,
      txInvalid:      summary.txInvalid,
      playersUpdated: summary.playerCount,
      coverage:       summary.coverage,
      durationMs:     Date.now() - startMs,
    }, 'Sync completed')

    return summary
  }

  /**
   * Fail-closed ante filas históricas sin plataforma con el mismo ID.
   *
   * Una fila vieja (platform NULL) y una nueva con plataforma tienen claves
   * únicas distintas: si fueran el mismo movimiento, se duplicaría. Como no se
   * sabe de qué plataforma es la fila vieja, no se escribe nada hasta que alguien
   * la clasifique (ver docs/runbooks/centro-monitoreo.md §4.3).
   */
  async _assertNoLegacyIdCollision(client, prepared) {
    if (!prepared.withId.length) return

    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n
       FROM casino_transactions
       WHERE platform IS NULL AND id_rec = ANY($1::bigint[])`,
      [prepared.withId.map(tx => tx.id_rec)],
    )
    const n = rows?.[0]?.n ?? 0
    if (n > 0) {
      throw new SyncError('LEGACY_UNCLASSIFIED',
        `${n} movimientos de ${this.platform} tienen el mismo ID que filas históricas sin plataforma; ` +
        'clasificarlas antes de sincronizar.')
    }
  }

  async _insertBatch(client, rows, withId) {
    if (!rows.length) return { inserted: 0, updated: 0 }

    const width  = withId ? 9 : 8
    const values = rows.map((_, j) => {
      const b = j * width
      return `(${Array.from({ length: width }, (_, k) => `$${b + k + 1}`).join(',')})`
    }).join(',')

    const sql = withId
      ? `INSERT INTO casino_transactions
           (platform, id_rec, fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles)
         VALUES ${values}
         ON CONFLICT (platform, id_rec) WHERE id_rec IS NOT NULL AND platform IS NOT NULL DO UPDATE
           SET fecha_hora_utc = EXCLUDED.fecha_hora_utc
           WHERE casino_transactions.fecha_hora_utc IS NULL
             AND EXCLUDED.fecha_hora_utc IS NOT NULL
         RETURNING (xmax = 0) AS inserted`
      : `INSERT INTO casino_transactions
           (platform, fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles)
         VALUES ${values}
         ON CONFLICT (platform, fecha, (LOWER(username)), tipo, monto, agente)
           WHERE id_rec IS NULL AND platform IS NOT NULL DO UPDATE
           SET fecha_hora_utc = EXCLUDED.fecha_hora_utc
           WHERE casino_transactions.fecha_hora_utc IS NULL
             AND EXCLUDED.fecha_hora_utc IS NOT NULL
         RETURNING (xmax = 0) AS inserted`

    const result   = await client.query(sql, rows.flat())
    const returned = result.rows ?? []
    const inserted = returned.filter(r => r.inserted).length
    return { inserted, updated: returned.length - inserted }
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
   * fetch con reintentos. Los errores que produce llevan SOLO texto controlado
   * (status HTTP, código de red, `context`): el mensaje de un error de red puede
   * incluir la URL con su query string o credenciales, así que nunca se propaga
   * ni se loguea.
   */
  async _fetchWithRetry(url, options, context = '') {
    const MAX_ATTEMPTS = 4

    let lastReason = 'sin respuesta'
    let lastStatus = null

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res
      try {
        res = await fetch(url, options)
      } catch (err) {
        res        = null
        lastStatus = null
        lastReason = `error de red (${networkReason(err)})`
      }

      if (res) {
        if (res.status >= 400 && res.status < 500) {
          throw Object.assign(
            new Error(`HTTP ${res.status} (non-retriable client error)`),
            { nonRetriable: true, httpStatus: res.status },
          )
        }
        if (res.ok) return res
        lastStatus = res.status
        lastReason = `HTTP ${res.status}`
      }

      if (attempt < MAX_ATTEMPTS) {
        const delayMs = 1000 * Math.pow(2, attempt - 1)
        this.log.warn({
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          delayMs,
          reason:      lastReason,
          context,
        }, 'Fetch failed, retrying')
        console.warn(
          `[${this.config.name}] Retry ${attempt}/${MAX_ATTEMPTS - 1} for ${context} — ` +
          `${lastReason}. Retrying in ${delayMs / 1000}s...`
        )
        await new Promise(r => setTimeout(r, delayMs))
      }
    }

    throw Object.assign(
      new Error(`[${this.config.name}] All ${MAX_ATTEMPTS} attempts failed for ${context}: ${lastReason}`),
      lastStatus ? { httpStatus: lastStatus } : {},
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

module.exports = { BaseCasinoConnector, normalizeIdRec, networkReason, PLAYER_LOCK_NAMESPACE }
