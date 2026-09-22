'use strict'

const { utcToLocalDate, addOneDay, DEFAULT_OFFSET_HOURS } = require('./dateHelpers')

/**
 * Fase 4 (D4/H7) — incremental sync window resolution.
 *
 * `--auto` used to compute ONE desde for the whole platform:
 *   SELECT MAX(fecha_hora_utc) - 30min FROM casino_transactions WHERE platform = $1
 * That is unsafe under partial failure: if agent B's run succeeds and inserts
 * rows with fecha_hora_utc newer than agent A's own data, a platform-wide MAX
 * advances PAST what agent A actually has — the next run computes a `desde`
 * for A that skips whatever A failed to sync last time. B's success silently
 * hides A's data loss.
 *
 * Fix: the watermark is scoped to `(platform, agente)`, not just `platform`.
 * `insertTransactions()` is atomic per call (BEGIN/COMMIT/ROLLBACK) — a
 * failed fetch/normalize/insert never partially commits, so
 * `MAX(fecha_hora_utc) WHERE platform=$1 AND agente=$2` only ever reflects
 * transaction rows that genuinely made it into the database for that agent.
 *
 * Recovery checkpoint (closing the gap the fase-4 review flagged): a MAX-based
 * watermark alone still loses recovery when `recomputePlayers()` — a SEPARATE
 * DB call from `insertTransactions()` inside `BaseCasinoConnector.syncAgent()`
 * — throws AFTER the transactions already committed. Without help, the next
 * `--auto` run's `desde` is `MAX(fecha_hora_utc) - 30min`, which sits entirely
 * AFTER the range that failed to recompute — that range's players are never
 * revisited. The same shape hits an explicit chunked historical run: if chunk
 * N fails, chunk N+1 must not run for that agent (orchestrator's job), but a
 * LATER `--auto` run still needs to know chunk N's range was never fully
 * resolved. `casino_sync_runs` (migration 128) already records `range_desde`/
 * `range_hasta` for every attempt (`_insertRunRow`/`_finishRunRow` in
 * `scripts/lib/casino-sync-orchestrator.js`) — this module reads that history
 * back (`_findRecoveryDesde`) instead of ignoring it: the earliest `failed`
 * run for this `(platform, agente)` whose range is not FULLY contained inside
 * a later `ok` run's range widens `desde` backward to cover it. A small later
 * success (e.g. a manual partial re-run) does not resolve a wider earlier
 * failure — only full containment counts, so no gap is silently declared
 * closed by a success that never actually covered it. Once a later `ok` run's
 * range does contain a failure's range, that failure stops widening desde
 * forever (replay is idempotent, but re-fetching the same history on every
 * single run would be wasteful and pointless).
 */

const OVERLAP_MINUTES  = 30
const GANAMOS_RETENTION_DAYS = 60 // upstream keeps ~60 days of per-transaction detail (plan Fase 3) — never worth requesting further back
const GANAMOS_STALE_WARN_DAYS = 7 // plan: warn when catching up more than this many days

/**
 * First-sync (no prior data at all for this agent) start date, per platform.
 * Explicit and documented — NOT a silent reuse of the old global default
 * ('2020-01-01'). Only applies when ZERO transactions exist yet for that
 * EXACT (platform, agente) pair — it never shortens or reinterprets any
 * range for an agent that already has data (the MAX-based branch below is
 * the only thing that runs once any row exists). The owner is expected to
 * run an explicit historical backfill separately
 * (`--desde=... --hasta=... --chunk-days=7`, or the Excel importer for
 * anything older than what the connector can pull) — this constant only
 * bounds what `--auto`'s FIRST run for a brand-new agent will fetch on its
 * own, so a fresh deploy doesn't try to walk years of history unattended.
 *
 * ganamos is intentionally absent: see `_resolveGanamosRange` below — its
 * bootstrap is "today only", governed by the 60-day retention window, not by
 * one of these dates.
 */
const AUTO_BOOTSTRAP_DESDE = Object.freeze({
  zeus:     '2024-01-01',
  bet30:    '2024-01-01',
  argenbet: '2026-01-01', // validated range starts August 2026 (plan §3) — no reason to reach further back unattended
})

/**
 * @param {import('pg').Pool | { query: Function }} pool
 * @param {string} platform
 * @param {string} agente
 * @param {{ now?: Date, log?: { warn: Function } }} [opts]
 * @returns {Promise<{ desde: string, hasta: string, mode: string, staleDays?: number|null, retentionCapped?: boolean }>}
 */
async function resolveIncrementalRange(pool, platform, agente, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date()
  const log = opts.log ?? { warn: () => {} }

  if (platform === 'ganamos') {
    return _resolveGanamosRange(pool, agente, now, log)
  }

  const { rows } = await pool.query(
    `SELECT MAX(fecha_hora_utc) AS last FROM casino_transactions WHERE platform = $1 AND agente = $2`,
    [platform, agente],
  )
  const last = rows[0]?.last ?? null

  const runRows       = await _fetchSyncRunRows(pool, platform, agente)
  const recoveryDesde = _earliestUnresolvedFailureDesde(runRows)

  if (!last) {
    const bootstrap = AUTO_BOOTSTRAP_DESDE[platform]
    if (!bootstrap) {
      throw new Error(`incrementalWindow: no AUTO_BOOTSTRAP_DESDE configured for platform "${platform}"`)
    }
    // A failed run can predate any transaction ever committed for this agent
    // (e.g. the very first attempt failed before insertTransactions() ran at
    // all) — recovering from it can only widen desde further into the past
    // than the bootstrap default, never narrow it.
    if (recoveryDesde && _desdeToMs(recoveryDesde) < _desdeToMs(bootstrap)) {
      return { desde: recoveryDesde, hasta: now.toISOString(), mode: 'recovery' }
    }
    return { desde: bootstrap, hasta: now.toISOString(), mode: 'bootstrap' }
  }

  const lastMs = last instanceof Date ? last.getTime() : new Date(last).getTime()
  if (isNaN(lastMs)) {
    throw new Error(`incrementalWindow: unparsable MAX(fecha_hora_utc) for (${platform}, ${agente}): ${JSON.stringify(last)}`)
  }
  const normalDesde = new Date(lastMs - OVERLAP_MINUTES * 60_000).toISOString()

  if (recoveryDesde && _desdeToMs(recoveryDesde) < _desdeToMs(normalDesde)) {
    return { desde: recoveryDesde, hasta: now.toISOString(), mode: 'recovery' }
  }

  return { desde: normalDesde, hasta: now.toISOString(), mode: 'incremental' }
}

/**
 * Ganamos (plan Fase 3): the payment/history endpoint never accepts a range
 * above 24h, so `hasta` is always "today" in Argentina local time (fixed
 * UTC-3, same convention `GanamosConnector` itself uses — computed via
 * `utcToLocalDate`, NOT `now.toISOString().slice(0,10)`, which is the UTC
 * calendar day and is wrong for roughly 3 hours around every ART midnight,
 * e.g. 2026-09-22T01:00Z is still 2026-09-21 in Argentina).
 *
 * `desde` is NOT always "today": if the agent has a last committed
 * transaction day older than today, this recovers day-by-day from that day
 * forward (GanamosConnector.fetchTransactions already iterates day-by-day
 * internally for any multi-day range) instead of silently jumping straight
 * to today and losing whatever fell in the gap — a missed run, a crashed
 * process, or a platform outage must not quietly cost data that is still
 * within the ~60-day retention window. The last known day is re-included on
 * purpose (not `lastDay + 1`): the run that produced it may have been
 * partial (crashed mid-day, or a day that was open when a run started), and
 * re-fetching is safe — `casino_transactions`' dedup is idempotent by `id`.
 *
 * If the gap exceeds the ~60-day retention window, anything older than that
 * is already gone upstream — the window is capped at
 * `GANAMOS_RETENTION_DAYS` and a warning is logged explicitly (never a
 * silent truncation). A gap over `GANAMOS_STALE_WARN_DAYS` (but still within
 * retention) also warns — still recoverable, but flagged.
 *
 * The anchor day this catch-up resumes from is NOT purely `MAX(fecha)` over
 * `casino_transactions` — a day with zero transactions for this agent (a
 * perfectly normal, successfully-synced day) leaves that MAX untouched, so a
 * committed-tx-only anchor would misreport the gap as reaching back to the
 * last day that happened to have activity, re-walking every zero-tx day in
 * between on every single run forever. The anchor is instead the MOST RECENT
 * of: the last day with a committed transaction, or the `range_hasta` of the
 * last `casino_sync_runs` row with `status='ok'` for this agent (recorded
 * regardless of whether that run inserted any transactions) — then, same as
 * before, an unresolved earlier `failed` run's day can pull the anchor
 * BACKWARD to recover a gap neither of those two signals alone would show
 * (e.g. the very first attempt ever for this agent failed with zero
 * committed data: no MAX(fecha), no prior 'ok' run, but a real gap to close).
 */
async function _resolveGanamosRange(pool, agente, now, log) {
  const today = utcToLocalDate(now.toISOString())

  const { rows } = await pool.query(
    `SELECT MAX(fecha) AS last_fecha FROM casino_transactions WHERE platform = 'ganamos' AND agente = $1`,
    [agente],
  )
  const lastFechaRaw     = rows[0]?.last_fecha ?? null
  const lastCommittedDay = lastFechaRaw ? _normalizeFecha(lastFechaRaw) : null

  const runRows = await _fetchSyncRunRows(pool, 'ganamos', agente)

  // A platform-level failure (connector construction/authenticate() blew up
  // BEFORE any agent's own attempt was even recorded — `agente IS NULL` in
  // casino_sync_runs, see runOrchestrator()) leaves NO per-agent row at all
  // for that day, so `runRows` alone is blind to it: an agent with zero prior
  // history would otherwise fall through to "today only" even though the
  // whole platform demonstrably never even tried that agent on that day.
  // Folded in as a synthetic same-day failed "run" so the same
  // resolved-by-a-later-ok-run containment check applies uniformly.
  const platformFailures = await _findPlatformFailures(pool, 'ganamos')
  const combinedRunRows  = [
    ...runRows,
    ...platformFailures.map((f) => ({
      status:      'failed',
      range_desde: _dayInART(f.started_at),
      range_hasta: _dayInART(f.started_at),
      started_at:  f.started_at,
    })),
  ]

  const lastOkHastaDay = _latestOkHastaDay(combinedRunRows)
  const recoveryDesde  = _earliestUnresolvedFailureDesde(combinedRunRows)

  let anchor = _maxYmd(lastCommittedDay, lastOkHastaDay)
  if (recoveryDesde) {
    const recoveryDay = _dayInART(recoveryDesde)
    if (!anchor || recoveryDay < anchor) anchor = recoveryDay
  }

  if (!anchor) {
    // No committed data AND no prior sync attempt (ok or failed) at all for
    // this agent — bootstrap is "today only", documented (plan): a historical
    // backfill is the owner's explicit, manual job (--desde/--hasta, bounded
    // by the 60-day retention window), never inferred silently here.
    return { desde: today, hasta: today, mode: 'ganamos-current-day', staleDays: null, retentionCapped: false }
  }

  const gapDays = _daysBetween(anchor, today)

  if (gapDays <= 0) {
    // Anchor is today (or, defensively, "in the future" — treat as today).
    return { desde: today, hasta: today, mode: 'ganamos-current-day', staleDays: null, retentionCapped: false }
  }

  const retentionCapped = gapDays > GANAMOS_RETENTION_DAYS
  const desde = retentionCapped
    ? _addDays(today, -GANAMOS_RETENTION_DAYS)
    : anchor // re-include the anchor day (may have been partial)

  if (retentionCapped) {
    log.warn(
      { agente, anchor, today, gapDays },
      `Ganamos: agent "${agente}" gap since last sync is ${gapDays} days, beyond the ~${GANAMOS_RETENTION_DAYS}-day ` +
      'retention window — data older than that is unrecoverable upstream. Catching up from the retention boundary only.',
    )
  } else if (gapDays > GANAMOS_STALE_WARN_DAYS) {
    log.warn(
      { agente, anchor, today, gapDays },
      `Ganamos: agent "${agente}" is catching up ${gapDays} days (last synced/attempted: ${anchor}) — still within the ` +
      `~${GANAMOS_RETENTION_DAYS}-day retention window, but this is a bigger gap than expected for a routine incremental run.`,
    )
  }

  return {
    desde,
    hasta: today,
    mode: retentionCapped ? 'ganamos-catchup-capped' : (gapDays > 0 ? 'ganamos-catchup' : 'ganamos-current-day'),
    staleDays: gapDays > GANAMOS_STALE_WARN_DAYS ? gapDays : null,
    retentionCapped,
  }
}

function _normalizeFecha(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

function _daysBetween(fromYmd, toYmd) {
  const from = new Date(`${fromYmd}T00:00:00Z`)
  const to   = new Date(`${toYmd}T00:00:00Z`)
  return Math.round((to.getTime() - from.getTime()) / 86_400_000)
}

function _addDays(ymd, delta) {
  let cursor = ymd
  const step = delta < 0 ? -1 : 1
  for (let i = 0; i < Math.abs(delta); i++) {
    cursor = step > 0 ? addOneDay(cursor) : _subtractOneDay(cursor)
  }
  return cursor
}

function _subtractOneDay(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

const PLAIN_DATE_RE       = /^\d{4}-\d{2}-\d{2}$/
const OFFSET_MS           = DEFAULT_OFFSET_HOURS * 3_600_000

/**
 * Reads the recovery-relevant history for `(platform, agente)` back out of
 * `casino_sync_runs` — every `failed` or `ok` row that recorded a range
 * (platform-level, agente=NULL rows are never returned here; neither are
 * `running`/`skipped` rows, which carry no completed-range information worth
 * comparing). Ordered oldest-first so `_earliestUnresolvedFailureDesde` can
 * assume any `ok` row appearing later in the array happened after any
 * `failed` row before it — ties broken by `started_at`, not array position,
 * since callers rely on `started_at` for the resolution check, not order.
 */
async function _fetchSyncRunRows(pool, platform, agente) {
  const { rows } = await pool.query(
    `SELECT status, range_desde, range_hasta, started_at FROM casino_sync_runs
     WHERE platform = $1 AND agente = $2 AND status IN ('failed', 'ok')
       AND range_desde IS NOT NULL AND range_hasta IS NOT NULL
     ORDER BY started_at ASC`,
    [platform, agente],
  )
  return rows
}

/**
 * ALL platform-level failed runs (`agente IS NULL` — connector construction
 * or `authenticate()` blew up before any agent's own attempt could even
 * start, see `runOrchestrator()`'s parent run row). These carry no
 * `range_desde`/`range_hasta` (nothing agent-specific was ever decided), so
 * they are invisible to `_fetchSyncRunRows()`'s per-agent query — only
 * `_resolveGanamosRange` folds them in, each as its own same-day synthetic
 * failure. NOT limited to the most recent one: three consecutive nights of
 * platform-wide outages are three separate missed days, and taking only the
 * latest would silently drop the earlier two — `_earliestUnresolvedFailureDesde`
 * needs the full list to find the EARLIEST unresolved one.
 */
async function _findPlatformFailures(pool, platform) {
  const { rows } = await pool.query(
    `SELECT started_at FROM casino_sync_runs
     WHERE platform = $1 AND agente IS NULL AND status = 'failed'
     ORDER BY started_at ASC`,
    [platform],
  )
  return rows
}

/**
 * Finds the earliest `failed` run's `range_desde` that no LATER `ok` run's
 * range fully contains — the checkpoint `resolveIncrementalRange` widens
 * `desde` back to, so a failure that left `casino_players` (or, for a fully
 * uncommitted attempt, `casino_transactions` itself) unrecovered is not lost
 * once the platform-wide MAX watermark moves past it. "Later" means a
 * strictly greater `started_at` — a success that happened BEFORE the failure
 * obviously cannot have fixed it. "Fully contains" means the success's own
 * interval covers the failure's interval on both ends — a smaller/later
 * success (e.g. a manual one-off re-run of just today) must not be mistaken
 * for having closed a wider historical gap. Returns `null` when there is
 * nothing unresolved.
 */
function _earliestUnresolvedFailureDesde(rows) {
  const failures  = rows.filter((r) => r.status === 'failed')
  const successes = rows.filter((r) => r.status === 'ok')

  let earliestDesde = null
  let earliestMs    = Infinity

  for (const failure of failures) {
    const fInterval = _rangeToIntervalMs(failure.range_desde, failure.range_hasta)
    if (!fInterval) continue

    const failureStartedMs = new Date(failure.started_at).getTime()
    const resolved = successes.some((success) => {
      if (new Date(success.started_at).getTime() <= failureStartedMs) return false
      const sInterval = _rangeToIntervalMs(success.range_desde, success.range_hasta)
      return !!sInterval && sInterval.fromMs <= fInterval.fromMs && sInterval.toMs >= fInterval.toMs
    })

    if (!resolved && fInterval.fromMs < earliestMs) {
      earliestMs    = fInterval.fromMs
      earliestDesde = failure.range_desde
    }
  }

  return earliestDesde
}

/** Latest `range_hasta` (as an ART calendar day) among `ok` rows — used by Ganamos to anchor on a clean zero-tx day. */
function _latestOkHastaDay(rows) {
  let latest = null
  for (const row of rows) {
    if (row.status !== 'ok') continue
    const day = _dayInART(row.range_hasta)
    if (!latest || day > latest) latest = day
  }
  return latest
}

/**
 * Converts a `casino_sync_runs.range_desde`/`range_hasta` value into the
 * Argentina-local calendar day it falls on, for Ganamos' day-granularity
 * anchor logic. A plain `YYYY-MM-DD` value (what Ganamos itself always
 * records) is already a calendar day and is returned as-is — no conversion,
 * since a bare date has no timezone to convert FROM. A full timestamp (only
 * possible here via a recovered failure recorded by another code path, or a
 * defensive edge case) genuinely needs the UTC->ART shift: naively slicing
 * its first 10 characters is the UTC calendar day, which is wrong for up to
 * 3 hours around every ART midnight (the exact class of bug `dateHelpers`'
 * own `utcToLocalDate` exists to avoid elsewhere in this codebase).
 */
function _dayInART(value) {
  if (value instanceof Date) return utcToLocalDate(value.toISOString())
  const str = String(value)
  return PLAIN_DATE_RE.test(str) ? str : utcToLocalDate(str)
}

/**
 * Converts a `desde` boundary (plain `YYYY-MM-DD` or exact ISO timestamp)
 * into a comparable instant, for comparing a recovery candidate against a
 * normal/bootstrap desde in `resolveIncrementalRange`. A plain date is
 * interpreted as ART midnight (matching `_rangeToIntervalMs`'s convention),
 * NOT UTC midnight — a failed historical chunk recorded as `"2026-09-21"`
 * starts at `2026-09-21T03:00:00Z`, three hours AFTER the exact-timestamp
 * `2026-09-21T01:00:00.000Z` overlap a same-day incremental run would compute
 * — comparing them via naive `new Date("2026-09-21").getTime()` (UTC
 * midnight) would wrongly treat that failed day as needing recovery when the
 * existing overlap already covers it, silently moving `desde` BACKWARD past
 * data that was never actually missed.
 */
function _desdeToMs(value) {
  const str = String(value)
  return PLAIN_DATE_RE.test(str) ? _artMidnightMs(str) : new Date(value).getTime()
}

function _maxYmd(a, b) {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

/**
 * Converts a `casino_sync_runs.range_desde`/`range_hasta` pair into a
 * comparable `[fromMs, toMs)` instant interval, regardless of whether the
 * platform recorded plain `YYYY-MM-DD` calendar days (Ganamos) or exact ISO
 * timestamps (Zeus/Bet30/Argenbet) — a day-based range is interpreted as the
 * Argentina-local calendar day (`[ART midnight of desde, ART midnight of the
 * day AFTER hasta)`), matching the convention `_resolveGanamosRange` and
 * `dateHelpers.buildApiDateRange` already use elsewhere. Returns `null` for
 * an unparsable pair instead of a bogus interval that could silently mask or
 * fabricate a containment/overlap result.
 */
function _rangeToIntervalMs(desde, hasta) {
  const desdeIsDate = PLAIN_DATE_RE.test(String(desde))
  const hastaIsDate = PLAIN_DATE_RE.test(String(hasta))

  const fromMs = desdeIsDate ? _artMidnightMs(String(desde)) : new Date(desde).getTime()
  const toMs   = hastaIsDate ? _artMidnightMs(addOneDay(String(hasta))) : new Date(hasta).getTime()

  if (isNaN(fromMs) || isNaN(toMs)) return null
  return { fromMs, toMs }
}

function _artMidnightMs(ymd) {
  return new Date(`${ymd}T00:00:00Z`).getTime() + OFFSET_MS
}

module.exports = {
  resolveIncrementalRange,
  AUTO_BOOTSTRAP_DESDE,
  OVERLAP_MINUTES,
  GANAMOS_RETENTION_DAYS,
  GANAMOS_STALE_WARN_DAYS,
  _earliestUnresolvedFailureDesde,
  _rangeToIntervalMs,
}
