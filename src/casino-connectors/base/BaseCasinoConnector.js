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

    // `source_id` (added by migration 126) is optional: Zeus/Bet30 never set it
    // (they only have a numeric id_rec), while connectors built against the
    // Excel-import identity scheme (Argenbet/Ganamos, fase 2/3) set it to the
    // raw upstream id string so both ingestion paths agree on what a given
    // record's "real" external id was, even when id_rec is a derived hash.
    for (const tx of normalizedTxs) {
      const row = [tx.fecha, tx.fecha_hora_utc, agente, tx.username, tx.tipo, tx.monto, tx.raw_detalles, platform, tx.source_id ?? null]
      if (tx.id_rec) {
        withId.push([tx.id_rec, ...row])
      } else {
        withoutId.push(row)
      }
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // scripts/import-casino-excel.js takes this exact named advisory lock
      // for its own write transaction. EVERY API ingestion batch — Zeus/Bet30
      // (no source_id, withoutId path) included — can race against a
      // concurrent Excel import of the SAME platform: the importer accepts
      // Movimientos files for any platform, not just the ones that carry
      // source_id. Scoping the lock to `hasSourceId` left Zeus/Bet30 batches
      // free to interleave their pre-insert collision SELECT with an
      // in-flight Excel import's INSERT (a real TOCTOU race), so it is taken
      // unconditionally here. Held only for this DB transaction (xact-scoped:
      // released automatically at COMMIT/ROLLBACK), never across an HTTP call.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('casino-excel-import'))")

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

    let playerCount
    try {
      playerCount = await this.recomputePlayers(normalizedTxs)
    } catch (err) {
      // insertTransactions() already committed its own transaction — this
      // failure does NOT roll that back. Attach the real count so the
      // orchestrator can still persist what was actually written to
      // casino_sync_runs.tx_inserted on the failed row (never silently
      // reported as 0 just because the run as a whole errored), and so this
      // is recognizable as "data landed but players are stale" rather than
      // "nothing happened" — that distinction is what lets
      // incrementalWindow's recovery checkpoint widen `desde` back to cover
      // this exact range instead of skipping past it on the next run.
      throw Object.assign(err, { insertedTxCount, recomputePlayersFailed: true })
    }

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
    const platform = this.config.name
    let inserted   = 0
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const rawChunk = rows.slice(i, i + BATCH_SIZE)

      // Postgres rejects "ON CONFLICT DO UPDATE command cannot affect row a
      // second time" if the SAME (platform, id_rec) appears twice in one
      // INSERT's VALUES list — even when the two rows are identical (e.g. an
      // overlapping sync window fetched the same transaction twice in the
      // same page). Collapse exact duplicates before building the statement;
      // a same-id_rec pair that DISAGREES on identity fields is a real
      // collision and must fail loudly here too, not just against what's
      // already in the DB.
      const chunk = this._dedupeIntraBatch(platform, rawChunk)

      // Identity-collision guard (fase 2): a connector that sets `source_id`
      // (Argenbet/Ganamos) can, in principle, compute the same id_rec for two
      // genuinely different upstream records (hash collision) — or the same
      // upstream id could show up with different amount/user/type due to a
      // caller bug. Either way this must be a loud failure, never a silent
      // `ON CONFLICT` overwrite that mixes the two records' data together.
      await this._assertNoIdentityCollisions(platform, chunk, client)

      const values = chunk.map((_, j) => {
        const b = j * 10
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10})`
      }).join(',')
      const result = await client.query(
        `INSERT INTO casino_transactions
           (id_rec, fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles, platform, source_id)
         VALUES ${values}
         ON CONFLICT (platform, id_rec) WHERE id_rec IS NOT NULL AND platform IS NOT NULL DO UPDATE
           SET fecha_hora_utc = COALESCE(casino_transactions.fecha_hora_utc, EXCLUDED.fecha_hora_utc),
               source_id      = COALESCE(casino_transactions.source_id, EXCLUDED.source_id)
           WHERE (casino_transactions.fecha_hora_utc IS NULL AND EXCLUDED.fecha_hora_utc IS NOT NULL)
              OR (casino_transactions.source_id IS NULL AND EXCLUDED.source_id IS NOT NULL)
         RETURNING (xmax = 0) AS inserted`,
        chunk.flat(),
      )
      // `rowCount` counts every row RETURNING produced, including a backfill
      // UPDATE that only patched fecha_hora_utc/source_id on an otherwise
      // unchanged replay (Zeus/Bet30 never carry source_id, so a re-synced
      // window would re-count as "inserted" on every single run). `xmax = 0`
      // is Postgres' own tell for "this tuple's transaction never expired an
      // older version" — true only for a genuine INSERT, false for the
      // ON CONFLICT DO UPDATE branch — so only those rows count here.
      inserted += (result.rows ?? []).filter(r => r.inserted).length
    }
    return inserted
  }

  /**
   * Compares two `monto` values for identity purposes (NOT for persistence).
   * Postgres NUMERIC(20,2) round-trips as a string like `"100.00"`, while a
   * JS-side value fetched fresh from an API might be the plain number `100`
   * (Zeus) or a fixed-decimal string `"100.00"` (Argenbet). A naive
   * `String(a) !== String(b)` treats `"100.00"` and `100` as different and
   * would misfire as a collision on every single Zeus re-sync.
   *
   * Canonicalizes both sides to an exact decimal string — sign normalized,
   * leading zeros of the integer part and trailing zeros of the fraction
   * stripped — WITHOUT ever routing the value through `Number`/`toFixed`.
   * `Number` only has ~15-17 significant decimal digits of precision, so for
   * a big-enough amount (e.g. `9007199254740991.01` vs `.02`) `Number(a)`
   * would silently round both to the same double and misfire as "equal" —
   * a real dedup that could hide a genuinely different transaction. Money
   * itself is never rounded here; an invalid/unparsable value never equals
   * anything, including another invalid value.
   */
  _montoEquals(a, b) {
    const ca = this._canonicalMonto(a)
    const cb = this._canonicalMonto(b)
    if (ca === null || cb === null) return false
    return ca === cb
  }

  /**
   * Returns an exact canonical decimal string for `value` (optional sign,
   * digits, optional fractional digits — no exponent, no thousands
   * separators), or `null` if it isn't one. String and number inputs both go
   * through the same regex-based canonicalization; a JS number is only
   * stringified first (`String(value)`), never divided/multiplied/`toFixed`,
   * so no precision is lost beyond whatever the number already carried.
   */
  _canonicalMonto(value) {
    if (value == null) return null
    const raw = typeof value === 'number'
      ? (Number.isFinite(value) ? String(value) : '')
      : String(value).trim()

    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw)
    if (!match) return null

    const [, signRaw, intRaw, fracRaw = ''] = match
    const intPart  = intRaw.replace(/^0+(?=\d)/, '')
    const fracPart = fracRaw.replace(/0+$/, '')
    const isZero   = intPart === '0' && fracPart === ''
    const sign     = signRaw === '-' && !isZero ? '-' : ''

    return `${sign}${intPart}${fracPart ? '.' + fracPart : ''}`
  }

  /**
   * Collapses byte-for-byte-equivalent duplicate rows that share the same
   * (platform, id_rec) within a single chunk (e.g. two overlapping fetch
   * pages both returned the same transaction) — Postgres would otherwise
   * reject the whole INSERT for touching the same conflict target twice, even
   * when the two rows are identical. A same-id_rec pair that disagrees on
   * source_id/monto/username/tipo/fecha is a genuine intra-batch collision
   * and throws immediately, same criteria as `_assertNoIdentityCollisions`.
   */
  _dedupeIntraBatch(platform, chunk) {
    const seen    = new Map()
    const deduped = []

    for (const row of chunk) {
      // row layout: [id_rec, fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles, platform, source_id]
      const [id_rec, fecha, , agente, username, tipo, monto, , , source_id] = row
      const key   = String(id_rec)
      const prior = seen.get(key)

      if (!prior) {
        seen.set(key, row)
        deduped.push(row)
        continue
      }

      const [, priorFecha, , priorAgente, priorUsername, priorTipo, priorMonto, , , priorSourceId] = prior
      if (this._identityConflicts({ username, tipo, monto, source_id, fecha, agente },
                                    { username: priorUsername, tipo: priorTipo, monto: priorMonto, source_id: priorSourceId, fecha: priorFecha, agente: priorAgente })) {
        throw new Error(
          `casino_transactions identity collision within the same batch on (platform="${platform}", id_rec=${id_rec}): ` +
          'two incoming records share an id_rec but disagree on source_id, monto, username, tipo, fecha or agente. ' +
          'Refusing to insert either — investigate the upstream page before retrying.'
        )
      }
      // Otherwise it's an exact duplicate (e.g. overlapping pagination windows) — drop it silently.
    }

    return deduped
  }

  /**
   * Shared discordance rule used by both the intra-batch and DB-lookup
   * collision guards. Compares `fecha` and `agente` too, not just
   * source_id/monto/username/tipo: two records CAN share the same id_rec,
   * amount, user and tipo while disagreeing on fecha or agente (e.g. an
   * Excel-corrected date for the same underlying player/monto/tipo) — that is
   * still a genuine identity conflict, not a re-sync no-op, and silently
   * treating it as a duplicate would let the wrong fecha/agente survive.
   * `_assertNoIdentityCollisions()` selects `fecha::text` explicitly so this
   * always compares plain `YYYY-MM-DD` strings, never a node-pg `Date` object
   * (which would misfire against the string this code uses elsewhere).
   * `agente` is compared trimmed/lowercased to match the Excel importer's own
   * normalization.
   */
  _identityConflicts(incoming, existing) {
    const sourceIdMismatch =
      existing.source_id != null && incoming.source_id != null && String(existing.source_id) !== String(incoming.source_id)
    const dataMismatch =
      !this._montoEquals(existing.monto, incoming.monto) ||
      String(existing.username).toLowerCase() !== String(incoming.username).toLowerCase() ||
      existing.tipo !== incoming.tipo ||
      this._normalizeFecha(existing.fecha) !== this._normalizeFecha(incoming.fecha) ||
      this._normalizeAgente(existing.agente) !== this._normalizeAgente(incoming.agente)
    return sourceIdMismatch || dataMismatch
  }

  _normalizeFecha(value) {
    if (value == null) return ''
    if (value instanceof Date) return value.toISOString().slice(0, 10)
    return String(value).slice(0, 10)
  }

  _normalizeAgente(value) {
    return String(value ?? '').trim().toLowerCase()
  }

  async _batchInsertWithoutId(rows, client) {
    const platform = this.config.name
    let inserted   = 0
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const rawChunk = rows.slice(i, i + BATCH_SIZE)

      // Same TOCTOU shape as `_dedupeIntraBatch()` above, but keyed on the
      // (platform, fecha, lower(username), tipo, monto, agente) conflict
      // target these rows use instead of id_rec — an overlapping fetch
      // window can hand back the exact same Zeus/Bet30 row twice, and
      // Postgres rejects an INSERT that touches the same ON CONFLICT target
      // twice even when the two rows are identical.
      const chunk = this._dedupeIntraBatchWithoutId(platform, rawChunk)

      const values = chunk.map((_, j) => {
        const b = j * 9
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9})`
      }).join(',')
      const result = await client.query(
        `INSERT INTO casino_transactions
           (fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles, platform, source_id)
         VALUES ${values}
         ON CONFLICT (platform, fecha, lower(username), tipo, monto, agente) WHERE id_rec IS NULL AND platform IS NOT NULL DO UPDATE
           SET fecha_hora_utc = EXCLUDED.fecha_hora_utc
           WHERE casino_transactions.fecha_hora_utc IS NULL AND EXCLUDED.fecha_hora_utc IS NOT NULL
         RETURNING (xmax = 0) AS inserted`,
        chunk.flat(),
      )
      // Same xmax=0 reasoning as `_batchInsertWithId()`: a Zeus/Bet30 replay
      // with no source_id would otherwise ON-CONFLICT-UPDATE (and count as
      // "inserted") on every single re-sync of the same window.
      inserted += (result.rows ?? []).filter(r => r.inserted).length
    }
    return inserted
  }

  /**
   * Collapses byte-for-byte-equivalent duplicate rows that share the same
   * (platform, fecha, lower(username), tipo, monto, agente) conflict target
   * within a single chunk — the same cardinality-violation Postgres error
   * `_dedupeIntraBatch()` guards against, just keyed on the composite target
   * the id_rec-less rows (Zeus/Bet30) use instead. `monto` is canonicalized
   * before joining the key so `100` and `"100.00"` collapse into the same
   * bucket, exactly like `_montoEquals()`. Two rows that land in the same
   * bucket are, by construction, already identical on every field the target
   * covers — the only field left that could genuinely disagree is
   * `source_id`, so that's the only contradiction this checks for.
   */
  _dedupeIntraBatchWithoutId(platform, chunk) {
    const seen    = new Map()
    const deduped = []

    for (const row of chunk) {
      // row layout: [fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles, platform, source_id]
      const [fecha, , agente, username, tipo, monto, , , source_id] = row
      const key = [
        this._normalizeFecha(fecha),
        String(username).toLowerCase(),
        tipo,
        this._canonicalMonto(monto),
        this._normalizeAgente(agente),
      ].join('|')
      const prior = seen.get(key)

      if (!prior) {
        seen.set(key, row)
        deduped.push(row)
        continue
      }

      const priorSourceId = prior[8]
      if (source_id != null && priorSourceId != null && String(source_id) !== String(priorSourceId)) {
        throw new Error(
          `casino_transactions identity collision within the same batch on ` +
          `(platform="${platform}", fecha=${fecha}, username="${username}", tipo="${tipo}", agente="${agente}"): ` +
          'two incoming records without id_rec share the same identity but disagree on source_id. ' +
          'Refusing to insert either — investigate the upstream page before retrying.'
        )
      }
      // Otherwise it's an exact duplicate (e.g. overlapping pagination windows) — drop it silently.
    }

    return deduped
  }

  /**
   * Looks up any row already persisted under the same (platform, id_rec) as
   * this incoming chunk and refuses to proceed if it disagrees on the fields
   * that establish identity: `source_id` (when both sides have one), the
   * core financial shape of the transaction (`monto`/`username`/`tipo`), or
   * `fecha`/`agente`. Throwing here aborts the whole `insertTransactions()` call — the caller's
   * BEGIN/COMMIT/ROLLBACK wrapper turns this into a full rollback, so nothing
   * from this batch is partially applied.
   */
  async _assertNoIdentityCollisions(platform, chunk, client) {
    const idRecs = [...new Set(chunk.map(row => String(row[0])))]
    if (!idRecs.length) return

    const { rows: existing = [] } = await client.query(
      `SELECT id_rec::text AS id_rec, fecha::text AS fecha, agente, source_id, monto, username, tipo
       FROM casino_transactions
       WHERE platform = $1 AND id_rec = ANY($2::bigint[])`,
      [platform, idRecs],
    )
    if (!existing || !existing.length) return

    const byIdRec = new Map(existing.map(row => [String(row.id_rec), row]))

    for (const row of chunk) {
      // row layout: [id_rec, fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles, platform, source_id]
      const [id_rec, fecha, , agente, username, tipo, monto, , , source_id] = row
      const prev = byIdRec.get(String(id_rec))
      if (!prev) continue

      if (this._identityConflicts({ username, tipo, monto, source_id, fecha, agente }, prev)) {
        throw new Error(
          `casino_transactions identity collision on (platform="${platform}", id_rec=${id_rec}): ` +
          'an existing row disagrees with the incoming record on source_id, monto, username, tipo, fecha or agente. ' +
          'Refusing to overwrite — this usually means two different upstream records produced the same ' +
          'id_rec (hash collision) or a caller bug. Investigate manually before retrying; no credentials ' +
          'or tokens are part of this message.'
        )
      }
    }
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
   *
   * `reauthenticate` (fase 3, Ganamos): optional zero-arg override for what
   * runs on a 401/403 instead of `this.authenticate()`. Ganamos authenticates
   * per-AGENT (one cookie jar each, not one shared connector-wide session) —
   * a global `this.authenticate()` has no way to know which agent's request
   * just got rejected. Rather than track that as connector-instance state
   * (e.g. `this.currentAgent`), which would race the moment two agents sync
   * concurrently through the same connector instance (agent B's request could
   * overwrite "current agent" mid-flight and agent A's retry would reauth the
   * wrong session), the caller passes a closure already bound to the right
   * agent. Connectors with a single shared session (Zeus/Bet30/Argenbet)
   * don't pass this and keep the original `this.authenticate()` behavior.
   */
  async _fetchWithRetry(url, options, context = '', reauthenticate = null) {
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
            await (reauthenticate ? reauthenticate() : this.authenticate())
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