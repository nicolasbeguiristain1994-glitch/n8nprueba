'use strict'

/**
 * Fase 4 — testable core of the casino sync orchestration.
 *
 * This module does NOT read .env, does NOT open a DB connection, and does
 * NOT run anything on require() — every dependency (pool, connector factory,
 * clock) is passed in by the caller. `scripts/sync-casino-players-live.js`
 * (CLI) and `scripts/pipeline-diario.js` (in-process, all 4 platforms) both
 * call `runOrchestrator()`; tests call it directly with fakes, no subprocess
 * needed.
 *
 * What it does, per call (one platform):
 *   1. Acquire the platform's advisory lock (shared/platformLock.js). If
 *      another run already holds it, record an optional 'skipped' run and
 *      return immediately — clean exit, no error.
 *   2. Mark any pre-existing 'running' rows for this platform as 'failed'
 *      ("abandoned") — the lock we just acquired proves no other legitimate
 *      run can be in progress, so a leftover 'running' row can only be a
 *      crash artifact from a process that never reached its own finally.
 *   3. Insert ONE platform-level parent run (agente=NULL) covering the whole
 *      call, from before connector construction to after every agent is
 *      done — this is what makes a connector-construction/authenticate()
 *      failure visible (closed 'failed' immediately, never left 'running'
 *      forever) and gives the dashboard a single row per platform run to
 *      show as in-progress.
 *   4. For each agent: resolve its sync window (per-agent incremental
 *      watermark in --auto mode, INSIDE the same try/catch as the sync call
 *      itself — a resolution failure for one agent must not abort the
 *      platform or leave that agent's attempt unrecorded) and run it,
 *      recording one casino_sync_runs row per attempt.
 *   5. Always release the lock, even on error.
 *
 * Returns a summary: { platform, locked, ok, results: [{agente, status,
 * txInserted, error?, desde, hasta}], error? } — never throws for a normal
 * agent-level failure (that's what `results[].status === 'error'` is for).
 * It DOES throw for input validation errors and if `casino_sync_runs`
 * itself is unusable (e.g. migration 128 not applied) — bookkeeping is a
 * hard requirement here, not best-effort; see `_insertRunRow`.
 */

const { createConnector: defaultCreateConnector } = require('../../src/casino-connectors/index')
const { acquirePlatformLock }                     = require('../../src/casino-connectors/shared/platformLock')
const { resolveIncrementalRange }                 = require('../../src/casino-connectors/shared/incrementalWindow')
const { sanitizeErrorMessage }                    = require('../../src/casino-connectors/shared/sanitizeError')
const { createLogger }                            = require('../../src/lib/logger')

const DEFAULT_CHUNK_DAYS       = 30
const DEFAULT_CONCURRENCY      = 1
const AGENT_POLITENESS_DELAY_MS = 400

/**
 * @param {object} opts
 * @param {string} opts.platform
 * @param {import('pg').Pool} opts.pool                    must allow >=2 simultaneous connections
 * @param {(platform: string, pool: object) => object} [opts.createConnector]
 * @param {() => Date} [opts.clock]
 * @param {boolean} [opts.auto]                             incremental per-agent watermark mode
 * @param {string} [opts.desde]                              required when !auto
 * @param {string} [opts.hasta]                              defaults to today when !auto
 * @param {string[]} opts.agentes                            resolved agent list — this module never queries the DB for it
 * @param {number} [opts.chunkDays]
 * @param {number} [opts.concurrency]
 * @param {import('pino').Logger} [opts.log]
 * @param {boolean} [opts.recordSkip]                        default true — see platformLock skip semantics
 */
async function runOrchestrator(opts) {
  const {
    platform,
    pool,
    createConnector = defaultCreateConnector,
    clock           = () => new Date(),
    auto            = false,
    desde           = null,
    hasta           = null,
    agentes,
    chunkDays       = DEFAULT_CHUNK_DAYS,
    concurrency     = DEFAULT_CONCURRENCY,
    log             = createLogger({ component: 'casino-sync-orchestrator', platform }),
    recordSkip      = true,
  } = opts

  _validateInputs({ platform, agentes, auto, desde, chunkDays, concurrency })

  const lock = await acquirePlatformLock(pool, platform)
  if (!lock.acquired) {
    log.warn({ platform }, 'Sync already running for this platform (advisory lock held) — skipping cleanly')
    if (recordSkip) {
      await _insertSkippedRun(pool, platform).catch((err) => {
        // A skip row is informational only — never let a bookkeeping hiccup
        // turn a clean, correct skip into a hard failure.
        log.warn({ err: err.message }, 'Could not record skipped run (non-fatal)')
      })
    }
    return { platform, locked: false, skipped: true, ok: true, results: [] }
  }

  try {
    const abandoned = await _markAbandonedRunningAsFailed(pool, platform, clock())
    if (abandoned > 0) {
      log.warn({ platform, count: abandoned }, 'Marked abandoned "running" casino_sync_runs rows as failed (crash recovery on lock re-acquisition)')
    }

    const parentRunId = await _insertRunRow(pool, { platform, agente: null, desde: null, hasta: null, startedAt: clock() })

    let connector
    try {
      connector = createConnector(platform, pool)
      await connector.authenticate()
    } catch (err) {
      const sanitized = sanitizeErrorMessage(err)
      log.error({ err: sanitized }, 'Platform-level failure — connector construction or authenticate()')
      await _finishRunRow(pool, parentRunId, { status: 'failed', error: sanitized, finishedAt: clock() })
      return { platform, locked: true, ok: false, error: sanitized, results: [] }
    }

    if (!agentes.length) {
      const message = 'No agents configured for this platform — refusing to report a clean run (config error, not a real success)'
      log.error({ platform }, message)
      await _finishRunRow(pool, parentRunId, { status: 'failed', error: message, finishedAt: clock() })
      return { platform, locked: true, ok: false, error: message, results: [] }
    }

    const results = auto
      ? await _runAutoAgents({ pool, connector, platform, agentes, chunkDays, clock, log })
      : await _runExplicitRangeAgents({ pool, connector, platform, agentes, desde, hasta: hasta || _today(clock()), chunkDays, concurrency, clock, log })

    const ok         = results.every((r) => r.status !== 'error')
    const totalTx     = results.reduce((sum, r) => sum + (r.txInserted ?? 0), 0)
    const failedNames = results.filter((r) => r.status === 'error').map((r) => r.agente)

    await _finishRunRow(pool, parentRunId, {
      status:     ok ? 'ok' : 'failed',
      txInserted: totalTx,
      error:      ok ? null : `agent(s) failed: ${failedNames.join(', ')}`,
      finishedAt: clock(),
    })

    return { platform, locked: true, ok, results }
  } finally {
    await lock.release()
  }
}

/**
 * A `--auto` range can be MUCH wider than a routine daily increment — a first
 * bootstrap (`AUTO_BOOTSTRAP_DESDE`) or a recovered failure spanning weeks
 * (see `incrementalWindow.js`'s recovery checkpoint) both resolve to a single
 * `{desde, hasta}` covering the whole gap. Handing that whole span to one
 * `connector.syncAgent()` call risks the upstream API (or this process) never
 * completing it, or the whole span rolling back as one unit on failure — this
 * splits it into `chunkDays`-bounded windows and runs them ONE AT A TIME,
 * preserving `desde`/`hasta`'s EXACT instants at both ends (no rounding to
 * day boundaries, so a recovery checkpoint that starts mid-day, or an
 * incremental `hasta` of "now", is never silently widened or truncated).
 * A normal small incremental window (the common daily-cron case) always
 * yields exactly one chunk identical to the original range — no behavior
 * change there.
 *
 * Ganamos is excluded: its `hasta` is always "today" and it accepts at most a
 * 24h request window upstream, so `GanamosConnector.fetchTransactions()`
 * already iterates day-by-day internally for a multi-day catch-up range —
 * chunking it again here would just add a redundant layer of bookkeeping
 * rows for the exact same single-agent work.
 */
async function _runAutoAgents({ pool, connector, platform, agentes, chunkDays, clock, log }) {
  const results = []
  for (const agente of agentes) {
    if (platform === 'ganamos' && typeof connector.checkStaleSync === 'function') {
      await _checkGanamosStaleSync(pool, connector, agente, clock, log)
    }

    let range
    try {
      range = await resolveIncrementalRange(pool, platform, agente, { now: clock(), log })
    } catch (err) {
      results.push(await _runAgentWithBookkeeping({ pool, connector, platform, agente, getRange: () => { throw err }, clock, log }))
      await _sleep(AGENT_POLITENESS_DELAY_MS)
      continue
    }

    const chunks = platform === 'ganamos'
      ? [{ desde: range.desde, hasta: range.hasta }]
      : _buildInstantChunks(range.desde, range.hasta, chunkDays)

    // A SINGLE bookkeeping row for the whole resolved range — inserted
    // 'running' with that FINAL range before the first chunk's HTTP call,
    // regardless of how many internal chunks it takes to walk it. This is
    // what makes the range auditable without holes: a mid-way chunk failure
    // marks this one row 'failed' with the FULL originally-intended range
    // (never just the chunk that broke), so a later --auto run's recovery
    // checkpoint (`_earliestUnresolvedFailureDesde`) widens all the way back
    // to the start and safely re-walks every chunk (idempotent replay) —
    // and, symmetrically, only an 'ok' row here (meaning EVERY chunk passed)
    // can ever resolve an earlier failure; a handful of successful chunks
    // with no row covering the complete range would leave that earlier,
    // wider failure pending forever.
    const runId = await _insertRunRow(pool, { platform, agente, desde: range.desde, hasta: range.hasta, startedAt: clock() })

    let txInserted = 0
    let failure    = null
    for (const chunk of chunks) {
      try {
        const { insertedTxCount } = await connector.syncAgent(agente, chunk.desde, chunk.hasta)
        txInserted += insertedTxCount ?? 0
      } catch (err) {
        failure = err
        break // later chunks for THIS agent never run
      }
      await _sleep(AGENT_POLITENESS_DELAY_MS)
    }

    if (failure) {
      const sanitized = sanitizeErrorMessage(failure)
      // `insertTransactions()` commits per chunk — a failed chunk can still
      // have written data before throwing (see BaseCasinoConnector.syncAgent()).
      const totalTx = txInserted + (Number.isInteger(failure?.insertedTxCount) ? failure.insertedTxCount : 0)
      await _finishRunRow(pool, runId, { status: 'failed', error: sanitized, txInserted: totalTx, finishedAt: clock() })
      log.error({ agent: agente, err: sanitized, desde: range.desde, hasta: range.hasta }, 'Agent sync failed')
      results.push({ agente, status: 'error', error: sanitized, txInserted: totalTx, desde: range.desde, hasta: range.hasta })
    } else {
      await _finishRunRow(pool, runId, { status: 'ok', txInserted, finishedAt: clock() })
      log.info({ agent: agente, txInserted, desde: range.desde, hasta: range.hasta }, 'Agent synced')
      results.push({ agente, status: 'ok', txInserted, desde: range.desde, hasta: range.hasta })
    }
    await _sleep(AGENT_POLITENESS_DELAY_MS)
  }
  return results
}

const PLAIN_DATE_RE_LOCAL = /^\d{4}-\d{2}-\d{2}$/
const ART_OFFSET_MS       = 3 * 3_600_000 // Argentina = UTC-3, no DST — matches dateHelpers.DEFAULT_OFFSET_HOURS

/** A plain `YYYY-MM-DD` boundary is interpreted as ART midnight (not UTC midnight) — same convention as `incrementalWindow.js`'s `_artMidnightMs`. */
function _instantMs(value) {
  return PLAIN_DATE_RE_LOCAL.test(String(value))
    ? Date.parse(`${value}T00:00:00Z`) + ART_OFFSET_MS
    : Date.parse(value)
}

/**
 * Splits `[desde, hasta]` into consecutive `{desde, hasta}` ISO-timestamp
 * chunks of at most `chunkDays` days each, both ends EXACT — the first
 * chunk's `desde` is the original `desde`'s exact instant (never rounded to
 * a day boundary even when the input was a plain date), and the last chunk's
 * `hasta` is the original `hasta`'s exact instant (never padded out to the
 * next day boundary, which matters when `hasta` is "now" mid-day). A range
 * no wider than one chunk returns a single chunk identical to the input.
 */
function _buildInstantChunks(desde, hasta, chunkDays) {
  const fromMs = _instantMs(desde)
  const toMs   = _instantMs(hasta)
  const stepMs = chunkDays * 86_400_000

  const chunks = []
  let cursor = fromMs
  while (cursor < toMs) {
    const end = Math.min(cursor + stepMs, toMs)
    chunks.push({ desde: new Date(cursor).toISOString(), hasta: new Date(end).toISOString() })
    cursor = end
  }
  if (!chunks.length) {
    chunks.push({ desde: new Date(fromMs).toISOString(), hasta: new Date(toMs).toISOString() })
  }
  return chunks
}

/**
 * Wires GanamosConnector.checkStaleSync() (plan Fase 3 — warn when an
 * agent's last successful sync is older than 7 days, since only ~60 days of
 * detail are retained upstream) to the real "last successful sync" signal:
 * `casino_sync_runs.finished_at` of that agent's most recent `status='ok'`
 * row. Never throws — a lookup failure here must not block the actual sync.
 */
async function _checkGanamosStaleSync(pool, connector, agente, clock, log) {
  try {
    const { rows } = await pool.query(
      `SELECT finished_at FROM casino_sync_runs
       WHERE platform = 'ganamos' AND agente = $1 AND status = 'ok'
       ORDER BY finished_at DESC LIMIT 1`,
      [agente],
    )
    const lastSuccessfulSyncAt = rows[0]?.finished_at ?? null
    connector.checkStaleSync(agente, lastSuccessfulSyncAt, clock())
  } catch (err) {
    log.warn({ agente, err: err.message }, 'Ganamos: could not check last-successful-sync staleness (non-fatal)')
  }
}

/**
 * Once a chunk fails for a given agent, that agent is dropped from every
 * SUBSEQUENT chunk in this same call — a historical backfill has no
 * meaningful "resume from the middle" within one invocation, and letting
 * later chunks run anyway would advance that agent's data past a range that
 * never actually landed, which is exactly the kind of silent gap this fase
 * exists to close. Other agents are unaffected (`agentes` is filtered per
 * chunk, not shared state that halts the whole loop). The failed chunk's
 * range is still recorded in `casino_sync_runs` (via
 * `_runAgentWithBookkeeping`) before this agent is dropped, so a LATER
 * `--auto` run's `resolveIncrementalRange()` can recover it — see
 * `src/casino-connectors/shared/incrementalWindow.js`'s
 * `_earliestUnresolvedFailureDesde`.
 */
async function _runExplicitRangeAgents({ pool, connector, platform, agentes, desde, hasta, chunkDays, concurrency, clock, log }) {
  const chunks = _buildDateChunks(desde, hasta, chunkDays)
  const limit  = _makeLimiter(concurrency)

  // One aggregated result per agent, folded across every chunk it appears in.
  const byAgent     = new Map(agentes.map((a) => [a, { agente: a, status: 'ok', txInserted: 0, desde, hasta, error: null }]))
  const failedAgents = new Set()

  for (const chunk of chunks) {
    const pending = agentes.filter((a) => !failedAgents.has(a))
    if (!pending.length) break // every agent already failed an earlier chunk — nothing left to attempt

    const chunkResults = await Promise.all(
      pending.map((agente) => limit(async () => {
        const r = await _runAgentWithBookkeeping({ pool, connector, platform, agente, getRange: async () => chunk, clock, log })
        await _sleep(AGENT_POLITENESS_DELAY_MS)
        return r
      })),
    )
    for (const r of chunkResults) {
      const acc = byAgent.get(r.agente)
      acc.txInserted += r.txInserted ?? 0
      if (r.status === 'error') {
        acc.status = 'error'
        acc.error  = acc.error ? `${acc.error}; ${r.error}` : r.error
        failedAgents.add(r.agente)
      }
    }
  }

  return [...byAgent.values()]
}

/**
 * Runs one agent for one window and records the attempt in casino_sync_runs
 * (running -> ok/failed). `getRange()` is called and awaited INSIDE this
 * function's own try/catch — a range-resolution failure for one agent
 * (e.g. a bad MAX(fecha_hora_utc) query) is recorded exactly like a sync
 * failure for that agent, and never aborts the rest of the platform's agents
 * (unlike the earlier version, where `resolveIncrementalRange()` was called
 * outside any per-agent try/catch in the caller).
 *
 * A `casino_sync_runs`-level failure (e.g. the table doesn't exist because
 * migration 128 hasn't been applied) is NOT caught here — it propagates out
 * so the caller treats it as a hard stop, not a per-agent sync failure
 * indistinguishable from a real one.
 */
async function _runAgentWithBookkeeping({ pool, connector, platform, agente, getRange, clock, log }) {
  let desde = null
  let hasta = null

  try {
    ;({ desde, hasta } = await getRange())

    const runId = await _insertRunRow(pool, { platform, agente, desde, hasta, startedAt: clock() })
    try {
      const { insertedTxCount, playerCount } = await connector.syncAgent(agente, desde, hasta)
      await _finishRunRow(pool, runId, { status: 'ok', txInserted: insertedTxCount, finishedAt: clock() })
      log.info({ agent: agente, txInserted: insertedTxCount, playerCount, desde, hasta }, 'Agent synced')
      return { agente, status: 'ok', txInserted: insertedTxCount, playerCount, desde, hasta }
    } catch (err) {
      const sanitized = sanitizeErrorMessage(err)
      // `insertTransactions()` runs in its own commit — a later failure (e.g.
      // recomputePlayers(), see BaseCasinoConnector.syncAgent()) does not
      // undo it, so this run's row must still reflect what actually landed
      // rather than defaulting to null/0 just because the attempt errored.
      const txInserted = Number.isInteger(err?.insertedTxCount) ? err.insertedTxCount : null
      await _finishRunRow(pool, runId, { status: 'failed', error: sanitized, txInserted, finishedAt: clock() })
      log.error({ agent: agente, err: sanitized, desde, hasta, txInserted }, 'Agent sync failed')
      return { agente, status: 'error', error: sanitized, txInserted, desde, hasta }
    }
  } catch (err) {
    if (err instanceof MissingTableError) throw err // hard stop — never record this as an ordinary agent failure
    // getRange() itself threw — still record a visible failure for this agent.
    const sanitized = sanitizeErrorMessage(err)
    log.error({ agent: agente, err: sanitized }, 'Agent sync window resolution failed')
    try {
      const runId = await _insertRunRow(pool, { platform, agente, desde, hasta, startedAt: clock() })
      await _finishRunRow(pool, runId, { status: 'failed', error: sanitized, finishedAt: clock() })
    } catch (bookkeepingErr) {
      if (bookkeepingErr instanceof MissingTableError) throw bookkeepingErr
      log.error({ agent: agente, err: bookkeepingErr.message }, 'Could not record window-resolution failure either (non-fatal, still reporting the agent as failed)')
    }
    return { agente, status: 'error', error: sanitized, desde, hasta }
  }
}

// ── input validation ────────────────────────────────────────────────────────

function _validateInputs({ platform, agentes, auto, desde, chunkDays, concurrency }) {
  if (!platform) throw new Error('runOrchestrator: opts.platform is required')
  if (!Array.isArray(agentes) || !agentes.every((a) => typeof a === 'string')) {
    throw new Error('runOrchestrator: opts.agentes (string[]) is required — this module never infers it from the DB')
  }
  if (!auto) {
    if (!desde || !/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
      throw new Error(`runOrchestrator: opts.desde must be a YYYY-MM-DD string when opts.auto is false, got: ${JSON.stringify(desde)}`)
    }
    if (!Number.isInteger(chunkDays) || chunkDays <= 0) {
      throw new Error(`runOrchestrator: opts.chunkDays must be a positive integer, got: ${JSON.stringify(chunkDays)}`)
    }
    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new Error(`runOrchestrator: opts.concurrency must be a positive integer, got: ${JSON.stringify(concurrency)}`)
    }
  }
}

// ── casino_sync_runs bookkeeping ────────────────────────────────────────────

const MISSING_TABLE_HINT =
  'casino_sync_runs no existe — el dueño de la base debe aplicar ' +
  'db/migrations/128_casino_sync_runs.sql antes de usar el orquestador de fase 4.'

class MissingTableError extends Error {}

function _wrapMissingTable(err) {
  if (err && err.code === '42P01') return new MissingTableError(MISSING_TABLE_HINT)
  return err
}

async function _insertRunRow(pool, { platform, agente, desde, hasta, startedAt }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO casino_sync_runs (platform, agente, started_at, status, range_desde, range_hasta)
       VALUES ($1, $2, $3, 'running', $4, $5)
       RETURNING id`,
      [platform, agente, startedAt, desde, hasta],
    )
    return rows[0].id
  } catch (err) {
    throw _wrapMissingTable(err)
  }
}

async function _finishRunRow(pool, id, { status, txInserted = null, error = null, finishedAt }) {
  try {
    await pool.query(
      `UPDATE casino_sync_runs SET status = $2, finished_at = $3, tx_inserted = $4, error = $5 WHERE id = $1`,
      [id, status, finishedAt, txInserted, error],
    )
  } catch (err) {
    throw _wrapMissingTable(err)
  }
}

async function _insertSkippedRun(pool, platform) {
  try {
    await pool.query(
      `INSERT INTO casino_sync_runs (platform, agente, started_at, finished_at, status)
       VALUES ($1, NULL, now(), now(), 'skipped')`,
      [platform],
    )
  } catch (err) {
    throw _wrapMissingTable(err)
  }
}

/**
 * Any row still `status='running'` for this platform BEFORE we insert our
 * own new run is, by construction, abandoned: the advisory lock we just
 * acquired proves no other legitimate process can currently be running a
 * sync for this platform, so a leftover 'running' row can only be a crash
 * artifact (process killed before reaching its own `finally`/catch). Marking
 * it 'failed' here — never silently left 'running' forever, which would
 * make the dashboard permanently show a stuck "in progress" state — uses
 * the lock's own mutual exclusion as proof, not a guessed/invented timeout.
 */
async function _markAbandonedRunningAsFailed(pool, platform, now) {
  try {
    const { rowCount } = await pool.query(
      `UPDATE casino_sync_runs
       SET status = 'failed', finished_at = $2,
           error = 'abandoned — no clean shutdown (previous process crash, detected on lock re-acquisition)'
       WHERE platform = $1 AND status = 'running'`,
      [platform, now],
    )
    return rowCount ?? 0
  } catch (err) {
    throw _wrapMissingTable(err)
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function _today(now) {
  return now.toISOString().slice(0, 10)
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Splits [desde, hasta] (YYYY-MM-DD) into consecutive chunks of at most
 * `chunkDays` days. Throws on an invalid/inverted range instead of silently
 * returning an empty chunk list, which would otherwise make the caller
 * report `ok:true` with zero agents actually synced.
 */
function _buildDateChunks(desde, hasta, chunkDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    throw new Error(`_buildDateChunks: desde/hasta must be YYYY-MM-DD, got desde=${JSON.stringify(desde)} hasta=${JSON.stringify(hasta)}`)
  }
  if (desde > hasta) {
    throw new Error(`_buildDateChunks: desde (${desde}) is after hasta (${hasta})`)
  }

  const chunks = []
  let cursor   = new Date(`${desde}T00:00:00Z`)
  const end    = new Date(`${hasta}T00:00:00Z`)

  while (cursor <= end) {
    const chunkStart = cursor.toISOString().slice(0, 10)
    const tentativeEnd = new Date(cursor)
    tentativeEnd.setUTCDate(tentativeEnd.getUTCDate() + chunkDays - 1)
    const chunkEnd = tentativeEnd <= end ? tentativeEnd : end

    chunks.push({ desde: chunkStart, hasta: chunkEnd.toISOString().slice(0, 10) })

    cursor = new Date(chunkEnd)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return chunks
}

/** Minimal concurrency limiter (avoids adding p-limit as a dependency of this module's own tests). */
function _makeLimiter(concurrency) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= concurrency || queue.length === 0) return
    active++
    const { fn, resolve, reject } = queue.shift()
    fn().then(resolve, reject).finally(() => { active--; next() })
  }
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next() })
}

/**
 * Records a platform-level failure that happened BEFORE `runOrchestrator()`
 * could even be called (e.g. `getConfigAgents()` throwing on a malformed
 * `platforms.config.json` entry) — so it still shows up in casino_sync_runs
 * instead of only living in a summary object nobody persists. No lock is
 * taken: nothing here could race against a real sync attempt for anything
 * it would corrupt (it's a single insert+update, not a data mutation), and
 * requiring the lock would only risk this failure going unrecorded if the
 * lock itself is what's unavailable.
 */
async function recordPlatformFailure(pool, platform, error, clock = () => new Date()) {
  const sanitized = sanitizeErrorMessage(error)
  const id = await _insertRunRow(pool, { platform, agente: null, desde: null, hasta: null, startedAt: clock() })
  await _finishRunRow(pool, id, { status: 'failed', error: sanitized, finishedAt: clock() })
  return sanitized
}

module.exports = {
  runOrchestrator,
  recordPlatformFailure,
  _buildDateChunks,
  MISSING_TABLE_HINT,
  MissingTableError,
}
