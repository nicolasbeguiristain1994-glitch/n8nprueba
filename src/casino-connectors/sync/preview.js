'use strict'

const { createHash } = require('crypto')
const { validPreviewScope } = require('./cli-args')
const { advanceCursor } = require('./cursor')
const { isValidDate } = require('./dates')
const { describeError } = require('./sanitize')

// Fixed ceilings: an incomplete sample is never reported as an exact preview.
const LIMITS = Object.freeze({ fetched: 5000, players: 250, history: 50000 })
const BIGINT_MAX = 9223372036854775807n
const METRICS = ['total_cargas', 'total_retiros', 'cant_cargas', 'cant_retiros']
const SILENT_LOG = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} })

class PreviewBlocked extends Error {
  constructor(code) { super(code); this.code = code }
}
function block(code) { throw new PreviewBlocked(code) }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function integer(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) block('UNSAFE_INTEGER')
  if (!/^-?\d+$/.test(String(value))) block('INVALID_INTEGER')
  return BigInt(value)
}
function sameMetadata(a, b) {
  return a.username === b.username && a.agente === b.agente && a.platform === b.platform
}

// DB timestamps are formatted in UTC with six digits, preserving microseconds.
function timestamp(value) {
  if (value === null || value === undefined) return null
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(\d{3})?Z$/.test(value)) block('TIMESTAMP_INDETERMINATE')
  if (!Number.isFinite(Date.parse(value))) block('TIMESTAMP_INDETERMINATE')
  return value.replace(/\.(\d{3})Z$/, '.$1000Z')
}
function normalizeStored(row) {
  if (!isValidDate(row.fecha) || typeof row.uname !== 'string'
    || typeof row.username !== 'string' || typeof row.agente !== 'string'
    || !['carga', 'retiro'].includes(row.tipo) || typeof row.eligible !== 'boolean') block('SOURCE_SHAPE_INVALID')
  return { ...row, id: integer(row.id), monto: integer(row.monto), fecha_hora_utc: timestamp(row.fecha_hora_utc) }
}

function aggregate(rows) {
  const result = new Map()
  for (const row of rows) {
    if (!row.eligible) continue
    let a = result.get(row.uname)
    if (!a) {
      a = { total_cargas: 0n, total_retiros: 0n, cant_cargas: 0n, cant_retiros: 0n,
        fecha_primera: row.fecha, fecha_ultima: row.fecha, candidates: [] }
      result.set(row.uname, a)
    }
    if (row.tipo === 'carga') { a.total_cargas += row.monto; a.cant_cargas++ }
    else { a.total_retiros += row.monto; a.cant_retiros++ }
    if (row.fecha < a.fecha_primera) a.fecha_primera = row.fecha
    if (row.fecha > a.fecha_ultima) a.fecha_ultima = row.fecha
    const previous = a.candidates[0]
    const compare = !previous ? 1 : row.fecha.localeCompare(previous.fecha)
      || ((row.fecha_hora_utc || '').localeCompare(previous.fecha_hora_utc || ''))
    if (compare > 0) a.candidates = [row]
    else if (compare === 0) a.candidates.push(row)
  }
  return result
}
function latest(a) {
  const candidates = a.candidates
  if (candidates.length === 1) return candidates[0]
  if (candidates.some(row => row.is_new)) {
    // INSERT IDs have not been allocated. Never nextval(), nor assume sequence
    // state. A tie only permits an exact metadata prediction if all values agree.
    if (!candidates.every(row => sameMetadata(row, candidates[0]))) block('METADATA_TIE_INDETERMINATE')
    return candidates[0]
  }
  return candidates.reduce((a, b) => a.id > b.id ? a : b)
}
function totals() { return Object.fromEntries(METRICS.map(key => [key, 0n])) }
function asText(values) { return Object.fromEntries(METRICS.map(key => [key, values[key].toString()])) }
function minus(a, b) { return asText(Object.fromEntries(METRICS.map(key => [key, a[key] - b[key]]))) }

/** Pure projection. No SQL, clock, sequence allocation, or returned player identities.
 * Mirrors _insertBatch (only fills missing timestamps) and recomputePlayers.
 * B is source history for players that C would recompute; no prior source = zero.
 */
function projectImpact({ prepared, history, conflicts, players, platform, agente, lowerAgent }) {
  const beforeRows = history.map(normalizeStored)
  const afterRows = beforeRows.map(row => ({ ...row }))
  const afterById = new Map(afterRows.map(row => [row.id.toString(), row]))
  const byConflict = new Map(conflicts.map(raw => { const row = normalizeStored(raw); return [String(row.id_rec), row] }))
  const byPlayer = new Map(players.map(row => [row.username_lower, row]))
  const targets = new Set(prepared.usernames)
  let inserted = 0, updated = 0, unchanged = 0, ignoredRevisions = 0

  for (const tx of prepared.withId) {
    const incoming = { ...tx, platform, agente, uname: tx.username.toLowerCase(),
      monto: integer(tx.monto), fecha_hora_utc: timestamp(tx.fecha_hora_utc),
      eligible: tx.username.toLowerCase() !== lowerAgent, is_new: true }
    const existing = byConflict.get(tx.id_rec)
    if (!existing) {
      afterRows.push(incoming); inserted++
      continue
    }
    // A reused ID for another player updates a row outside the requested
    // recompute target set. Keep this first-pilot preview fail-closed.
    if (!targets.has(existing.uname)) block('CONFLICT_OUTSIDE_PLAYER_SCOPE')
    if (existing.fecha !== incoming.fecha || existing.monto !== incoming.monto
      || existing.tipo !== incoming.tipo || existing.agente !== incoming.agente
      || existing.uname !== incoming.uname) ignoredRevisions++
    const projected = afterById.get(existing.id.toString())
    if (!projected) block('CONFLICT_SNAPSHOT_INCONSISTENT')
    if (existing.fecha_hora_utc === null && incoming.fecha_hora_utc !== null) {
      projected.fecha_hora_utc = incoming.fecha_hora_utc; updated++
    } else unchanged++
  }

  const beforeSource = aggregate(beforeRows), afterSource = aggregate(afterRows)
  const A = totals(), B = totals(), C = totals()
  const summary = { targets: targets.size, recomputed: 0, existing: 0, created: 0,
    unchanged_targets: 0, aggregates_changed: 0, aggregates_decreased: 0,
    agent_changed: 0, platform_changed: 0, first_date_changed: 0, last_date_changed: 0 }
  for (const uname of targets) {
    const c = afterSource.get(uname)
    if (!c) { summary.unchanged_targets++; continue }
    const a = byPlayer.get(uname), b = beforeSource.get(uname) || totals()
    const recent = latest(c)
    summary.recomputed++
    if (a) summary.existing++
    else summary.created++
    const old = totals()
    for (const key of METRICS) {
      old[key] = a ? integer(a[key]) : 0n
      A[key] += old[key]; B[key] += b[key]; C[key] += c[key]
      if (c[key] > BIGINT_MAX || c[key] < -BIGINT_MAX - 1n
        || (key.startsWith('cant_') && c[key] > 2147483647n)) block('PROJECTED_AGGREGATE_OVERFLOW')
    }
    if (METRICS.some(key => c[key] !== old[key])) summary.aggregates_changed++
    if (METRICS.some(key => c[key] < old[key])) summary.aggregates_decreased++
    if (a) {
      if (a.agente !== recent.agente) summary.agent_changed++
      if (a.platform !== (recent.platform ?? a.platform)) summary.platform_changed++
      if (a.fecha_primera !== c.fecha_primera) summary.first_date_changed++
      if (a.fecha_ultima !== c.fecha_ultima) summary.last_date_changed++
    }
  }
  return {
    transactions: { inserted, timestamp_updated: updated, unchanged, provider_revisions_not_applied: ignoredRevisions },
    players: summary,
    aggregates: { A_current: asText(A), B_existing_source: asText(B), C_projected: asText(C) },
    deltas: { historical_recompute: minus(B, A), new_batch: minus(C, B), effective: minus(C, A) },
    unchanged_columns: ['seg_monto', 'seg_actividad', 'labels'],
  }
}

const TX_FIELDS = `id::text, id_rec::text, LOWER(username) AS uname, username, agente, platform,
  tipo, monto::text, fecha::text,
  to_char(fecha_hora_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS fecha_hora_utc,
  (LOWER(username) <> LOWER(agente)) AS eligible`
const SQL = Object.freeze({
  legacy: `SELECT COUNT(*)::text AS n FROM public.casino_transactions
    WHERE platform IS NULL AND LOWER(agente) = LOWER($1) AND fecha BETWEEN $2::date AND $3::date`,
  legacyIds: `SELECT COUNT(*)::text AS n FROM public.casino_transactions
    WHERE platform IS NULL AND id_rec = ANY($1::bigint[])`,
  names: `SELECT username, LOWER(username) AS uname, LOWER($2::text) AS lower_agent
    FROM unnest($1::text[]) AS names(username)`,
  history: `SELECT ${TX_FIELDS} FROM public.casino_transactions
    WHERE LOWER(username) = ANY($1::text[]) ORDER BY id LIMIT $2`,
  conflicts: `SELECT ${TX_FIELDS} FROM public.casino_transactions
    WHERE platform = $1 AND id_rec = ANY($2::bigint[]) ORDER BY id LIMIT $3`,
  players: `SELECT username_lower, agente, platform, total_cargas::text, total_retiros::text,
    cant_cargas::text, cant_retiros::text, fecha_primera::text, fecha_ultima::text
    FROM public.casino_players WHERE username_lower = ANY($1::text[]) ORDER BY username_lower LIMIT $2`,
  cursor: `SELECT covered_from::text, covered_through::text FROM public.casino_sync_cursors
    WHERE platform = $1 AND agente = $2`,
})

/** Read-only preview; deliberately does not invoke runSync, syncAgent, a store,
 * persistence hooks, advisory locks, sequence functions, or segmentation.
 * A preview is an observation, never authorization or a promise of a future write.
 */
async function runPreview(opts, deps) {
  const now = deps.now || (() => new Date())
  const report = { mode: 'preview', read_only: true, write_authorized: false,
    status: 'failed', exitCode: 1, generated_at: now().toISOString(), impact: null,
    limits: LIMITS, assumptions: [
      'Exact projection at the read-only snapshot; future sync must be reviewed again if input or DB changes.',
      'No provider completeness guarantee. Nothing is persisted, including runs and cursors.',
      'A/B/C include only targets that the projected batch would recompute; amounts are integer strings.',
    ] }
  let client, inTransaction = false, brokenClient
  async function snapshot(fn) {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    inTransaction = true
    const readOnly = (await client.query('SHOW transaction_read_only')).rows
    if (readOnly.length !== 1 || readOnly[0].transaction_read_only !== 'on') block('READ_ONLY_NOT_ENFORCED')
    const isolation = (await client.query('SHOW transaction_isolation')).rows
    if (isolation.length !== 1 || isolation[0].transaction_isolation !== 'repeatable read') block('SNAPSHOT_NOT_ENFORCED')
    await client.query("SET LOCAL statement_timeout = '20s'; SET LOCAL lock_timeout = '1s'; SET LOCAL idle_in_transaction_session_timeout = '30s'")
    const result = await fn()
    await client.query('ROLLBACK')
    inTransaction = false
    return result
  }
  async function read(sql, params) {
    if (!inTransaction || !Object.values(SQL).includes(sql)) block('UNREVIEWED_READ')
    return (await client.query(sql, params)).rows
  }
  function interrupted() { if (opts.signal?.aborted) block('PREVIEW_INTERRUPTED') }
  async function legacyCheck() {
    const rows = await read(SQL.legacy, [opts.agentes[0], opts.desde, opts.hasta])
    if (rows.length !== 1 || integer(rows[0].n) !== 0n) block('LEGACY_RANGE_UNCLASSIFIED')
  }
  try {
    if (!validPreviewScope(opts, now())) { report.exitCode = 2; block('PREVIEW_SCOPE_INVALID') }
    report.scope = { platform: opts.platform, agente: opts.agentes[0], desde: opts.desde, hasta: opts.hasta }
    interrupted()
    client = await deps.pool.connect()
    // Confirm read-only DB and the range before authenticating with a provider.
    await snapshot(legacyCheck)
    interrupted()
    const connector = deps.createConnector(opts.platform, null)
    connector.log = SILENT_LOG
    await connector.authenticate()
    interrupted()
    const fetchedAt = now()
    const raw = await connector.fetchTransactions(opts.agentes[0], opts.desde, opts.hasta)
    interrupted()
    if (!Array.isArray(raw)) block('INVALID_PROVIDER_RESPONSE')
    if (raw.length > LIMITS.fetched) block('FETCH_LIMIT_EXCEEDED')
    const normalized = await connector.normalizeWithStats(raw)
    if (!Array.isArray(normalized.rows) || ![normalized.invalid, normalized.excluded].every(n => Number.isSafeInteger(n) && n >= 0)
      || normalized.rows.length + normalized.invalid + normalized.excluded !== raw.length) block('NORMALIZATION_INDETERMINATE')
    const prepared = connector.prepareTransactions(normalized.rows)
    report.batch = { fetched: raw.length, normalized: normalized.rows.length,
      excluded: normalized.excluded, invalid: normalized.invalid + prepared.stats.invalid,
      without_id: prepared.stats.withoutId, duplicate_ids: prepared.stats.duplicateIds,
      collapsed_without_id: prepared.stats.collapsedWithoutId, targets: prepared.usernames.length }
    if (report.batch.invalid) block('INVALID_TRANSACTIONS')
    if (prepared.withoutId.length) block('UNIDENTIFIED_TRANSACTIONS')
    if (prepared.usernames.length > LIMITS.players) block('PLAYER_LIMIT_EXCEEDED')
    for (const tx of prepared.withId) {
      if (!Number.isSafeInteger(tx.monto) || tx.monto < 0) block('UNSAFE_PROVIDER_AMOUNT')
      if (tx.fecha !== opts.desde) block('PROVIDER_RANGE_MISMATCH')
      if (tx.username.length > 100 || opts.agentes[0].length > 50) block('TEXT_LENGTH_EXCEEDED')
      timestamp(tx.fecha_hora_utc)
    }
    // Duplicate IDs with differing content are not a sound first-pilot input.
    const byId = new Map()
    for (const tx of normalized.rows) {
      const single = connector.prepareTransactions([tx]).withId[0]
      if (!single) continue
      const fingerprint = digest(single)
      if (byId.has(single.id_rec) && byId.get(single.id_rec) !== fingerprint) block('DUPLICATE_ID_CONTENT_CONFLICT')
      byId.set(single.id_rec, fingerprint)
    }
    const data = await snapshot(async () => {
      interrupted()
      await legacyCheck()
      const ids = prepared.withId.map(tx => tx.id_rec)
      const collision = await read(SQL.legacyIds, [ids])
      if (collision.length !== 1 || integer(collision[0].n) !== 0n) block('LEGACY_ID_UNCLASSIFIED')
      const names = await read(SQL.names, [prepared.withId.map(tx => tx.username), opts.agentes[0]])
      if (names.length !== prepared.withId.length || names.some(row => row.uname !== row.username.toLowerCase()
        || row.lower_agent !== opts.agentes[0].toLowerCase())) block('CASE_MAPPING_INDETERMINATE')
      const history = await read(SQL.history, [prepared.usernames, LIMITS.history + 1])
      if (history.length > LIMITS.history) block('HISTORY_LIMIT_EXCEEDED')
      const conflicts = await read(SQL.conflicts, [opts.platform, ids, LIMITS.fetched + 1])
      if (conflicts.length > LIMITS.fetched) block('CONFLICT_LIMIT_EXCEEDED')
      const players = await read(SQL.players, [prepared.usernames, LIMITS.players + 1])
      if (players.length > LIMITS.players) block('PLAYER_LIMIT_EXCEEDED')
      const cursors = await read(SQL.cursor, [opts.platform, opts.agentes[0]])
      if (cursors.length > 1) block('CURSOR_INDETERMINATE')
      return { history, conflicts, players, cursor: cursors[0] || null }
    })
    interrupted()
    const impact = projectImpact({ ...data, prepared, platform: opts.platform,
      agente: opts.agentes[0], lowerAgent: opts.agentes[0].toLowerCase() })
    const beforeCursor = data.cursor ? { coveredFrom: data.cursor.covered_from, coveredThrough: data.cursor.covered_through } : null
    report.cursor_projection = { before: beforeCursor,
      ...advanceCursor(beforeCursor, { desde: opts.desde, hasta: opts.hasta, fetchStartedAt: fetchedAt }) }
    report.batch_sha256 = digest({ scope: report.scope, prepared })
    report.snapshot_sha256 = digest(data)
    report.impact = impact
    report.status = 'complete'; report.exitCode = 0
  } catch (err) {
    report.status = err instanceof PreviewBlocked ? 'blocked' : 'failed'
    report.error_code = err instanceof PreviewBlocked ? err.code : describeError(err).code
    report.impact = null
  } finally {
    if (client) {
      if (inTransaction) {
        try { await client.query('ROLLBACK') }
        catch (err) { brokenClient = err; report.status = 'failed'; report.exitCode = 1; report.error_code = 'READ_ONLY_CLEANUP_FAILED'; report.impact = null }
      }
      client.release(brokenClient)
    }
  }
  return report
}

// Match the frontend's existing connection/SSL interpretation, only for preview.
// The normal writer's pool options are deliberately unchanged.
function previewPoolOptions(env) {
  const url = new URL(env.DATABASE_URL.trim())
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) block('INVALID_DB_URL')
  if (!url.searchParams.has('uselibpqcompat')) url.searchParams.set('uselibpqcompat', 'true')
  return { connectionString: url.toString(), max: 1,
    ssl: String(env.DB_SSL || '').trim() === 'false' ? false
      : { rejectUnauthorized: String(env.DB_SSL_REJECT_UNAUTHORIZED || '').trim() === 'true' },
    connectionTimeoutMillis: 10000, query_timeout: 25000,
    options: '-c default_transaction_read_only=on' }
}

module.exports = { runPreview, projectImpact, previewPoolOptions, LIMITS, SQL }
