import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { getAgentsSqlArray, isValidPlatform } from '@/lib/casino-agents'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CasinoJugador {
  username:      string
  agente:        string
  seg_monto:     string
  seg_actividad: string
  total_cargas:  number
  cant_cargas:   number
  total_retiros: number
  cant_retiros:  number
  neto:          number
  dias_ultimo:   number | null
  fecha_ultima:  string | null
  // Computed from casino_players fields — same logic as contact_tags auto-tagging.
  // No join to contact_tags is needed: both are deterministic functions of the
  // same casino_players columns (seg_actividad, seg_monto, fecha_primera).
  valor_riesgo:  string | null   // 'critico' | 'medio' | 'bajo' | null
  antiguedad:    string | null   // 'nuevo' | 'reciente' | 'establecido' | 'veterano' | 'leal' | null
  labels:        string[]        // etiquetas operativas asignadas desde el dashboard
}

export interface CasinoJugadoresResponse {
  jugadores:          CasinoJugador[]
  total:              number
  page:               number
  limit:              number
  // Aggregate totals across the FULL filtered set (not just the current page).
  // Computed server-side alongside the COUNT query so the UI can display
  // correct Σ Cargas / Σ Retiros regardless of page size.
  total_cargas_sum:   number
  total_retiros_sum:  number
  total_cant_cargas:  number
  total_cant_retiros: number
}

// ── Sort whitelist — only these column aliases may appear in ORDER BY ─────────
const SORT_COLS = new Set([
  'total_cargas', 'total_retiros', 'neto', 'dias_ultimo',
  'cant_cargas',  'cant_retiros',  'username', 'agente',
])

// ── valor_riesgo / antiguedad filter whitelists ───────────────────────────────
// These values must exactly match the CASE expressions in the import route
// (frontend/app/api/contacts/import/route.ts) so that filtering and tagging
// stay in sync.
const VALOR_RIESGO_ALLOWED = new Set(['bajo', 'medio', 'critico'])
const ANTIGUEDAD_ALLOWED   = new Set(['nuevo', 'reciente', 'establecido', 'veterano', 'leal'])

// ── casino_players enum whitelists ────────────────────────────────────────────
// Canonical values from migrations 025 + 027.
const NIVEL_ALLOWED = new Set(['bajo', 'medio', 'vip', 'super_vip'])
const SEG_ACTIVIDAD_ALLOWED = new Set([
  'nuevo', 'frecuente', 'regular', 'ocasional', 'en_riesgo', 'inactivo', 'perdido',
])

// ── Static SQL condition maps ──────────────────────────────��──────────────────
// Each value maps to the exact SQL boolean expression that identifies it.
// These strings are never derived from user input — they are only selected
// by whitelisted keys, so no SQL injection is possible.

// Historical mode (columns belong to casino_players directly, no alias)
const VR_HIST: Record<string, string> = {
  critico: `(seg_actividad IN ('perdido','inactivo','en_riesgo') AND seg_monto IN ('super_vip','vip'))`,
  medio:   `(seg_actividad IN ('perdido','inactivo','en_riesgo') AND seg_monto = 'medio')`,
  bajo:    `(seg_actividad IN ('perdido','inactivo','en_riesgo') AND seg_monto = 'bajo')`,
}
const ANT_HIST: Record<string, string> = {
  nuevo:       `(fecha_primera IS NOT NULL AND (CURRENT_DATE - fecha_primera) <   30)`,
  reciente:    `(fecha_primera IS NOT NULL AND (CURRENT_DATE - fecha_primera) >=  30 AND (CURRENT_DATE - fecha_primera) <  90)`,
  establecido: `(fecha_primera IS NOT NULL AND (CURRENT_DATE - fecha_primera) >=  90 AND (CURRENT_DATE - fecha_primera) < 150)`,
  veterano:    `(fecha_primera IS NOT NULL AND (CURRENT_DATE - fecha_primera) >= 150 AND (CURRENT_DATE - fecha_primera) < 270)`,
  leal:        `(fecha_primera IS NOT NULL AND (CURRENT_DATE - fecha_primera) >= 270)`,
}

// Period mode (casino_players is LEFT JOINed as alias 'cp')
const VR_PERIOD: Record<string, string> = {
  critico: `(cp.seg_actividad IN ('perdido','inactivo','en_riesgo') AND cp.seg_monto IN ('super_vip','vip'))`,
  medio:   `(cp.seg_actividad IN ('perdido','inactivo','en_riesgo') AND cp.seg_monto = 'medio')`,
  bajo:    `(cp.seg_actividad IN ('perdido','inactivo','en_riesgo') AND cp.seg_monto = 'bajo')`,
}
const ANT_PERIOD: Record<string, string> = {
  nuevo:       `(cp.fecha_primera IS NOT NULL AND (CURRENT_DATE - cp.fecha_primera) <   30)`,
  reciente:    `(cp.fecha_primera IS NOT NULL AND (CURRENT_DATE - cp.fecha_primera) >=  30 AND (CURRENT_DATE - cp.fecha_primera) <  90)`,
  establecido: `(cp.fecha_primera IS NOT NULL AND (CURRENT_DATE - cp.fecha_primera) >=  90 AND (CURRENT_DATE - cp.fecha_primera) < 150)`,
  veterano:    `(cp.fecha_primera IS NOT NULL AND (CURRENT_DATE - cp.fecha_primera) >= 150 AND (CURRENT_DATE - cp.fecha_primera) < 270)`,
  leal:        `(cp.fecha_primera IS NOT NULL AND (CURRENT_DATE - cp.fecha_primera) >= 270)`,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true when s is a valid YYYY-MM-DD calendar date. */
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(s)
  return !isNaN(d.getTime())
}

/** Adds n days to a YYYY-MM-DD string. Uses noon UTC to avoid DST edge cases. */
function addDays(date: string, n: number): string {
  const d = new Date(date + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * Converts a UTC datetime (date + HH:MM) to the Argentina local date (UTC-3, no DST).
 * Used when tz_mode=utc to map operator-entered UTC timestamps to stored local dates.
 */
function utcDatetimeToArgDate(date: string, time: string): string {
  const utcMs = new Date(date + 'T' + time + ':00Z').getTime()
  return new Date(utcMs - 3 * 3_600_000).toISOString().slice(0, 10)
}

/**
 * Computes effective date bounds for rows that lack fecha_hora_utc (old rows).
 * These are DATE-level bounds used as the fallback when sub-day precision is unavailable.
 *
 * Matches Zeus semantics:
 *   "From: 2026-04-01 00:00 Local" → fecha >= '2026-04-01'
 *   "To:   2026-04-03 00:00 Local" → fecha <  '2026-04-03'  (exclusive)
 *
 * When horaHasta > '00:00' (local) the target date IS included for old rows
 * (best-effort: we don't know if the transaction was before or after that hour).
 */
function effectiveDateBounds(
  fechaDesde:  string | null,
  fechaHasta:  string | null,
  horaDesde:   string,
  horaHasta:   string,
  tzMode:      'local' | 'utc',
): { desde: string | null; hastaExclusive: string | null } {
  let desde: string | null = null
  let hastaExclusive: string | null = null

  if (fechaDesde) {
    desde = tzMode === 'utc'
      ? utcDatetimeToArgDate(fechaDesde, horaDesde)
      : fechaDesde
  }

  if (fechaHasta) {
    if (tzMode === 'utc') {
      const argDate    = utcDatetimeToArgDate(fechaHasta, horaHasta)
      const argMs      = new Date(fechaHasta + 'T' + horaHasta + ':00Z').getTime() - 3 * 3_600_000
      const argMinutes = new Date(argMs).getUTCHours() * 60 + new Date(argMs).getUTCMinutes()
      hastaExclusive   = argMinutes > 0 ? addDays(argDate, 1) : argDate
    } else {
      // horaHasta '00:00' → exclusive (Zeus default: date not included)
      // horaHasta > '00:00' → include that date (overinclusive for rows without timestamps,
      //                       but better than silently dropping the whole day)
      hastaExclusive = horaHasta === '00:00' ? fechaHasta : addDays(fechaHasta, 1)
    }
  }

  return { desde, hastaExclusive }
}

/**
 * Computes exact TIMESTAMPTZ bounds for filtering casino_transactions.fecha_hora_utc.
 *
 * The operator enters a date+time boundary in local Argentina or UTC, exactly as
 * Zeus displays it. Both bounds are EXCLUSIVE upper / INCLUSIVE lower:
 *   "From: 2026-04-01 00:00 Local" → fecha_hora_utc >= '2026-04-01T03:00:00Z'
 *   "To:   2026-04-03 00:00 Local" → fecha_hora_utc <  '2026-04-03T03:00:00Z'
 *   "To:   2026-04-03 12:00 Local" → fecha_hora_utc <  '2026-04-03T15:00:00Z'
 *
 * Argentina = UTC-3 (fixed, no DST). ISO suffix '-03:00' encodes this directly.
 * The DB driver and PostgreSQL then normalise to UTC for comparison against
 * stored TIMESTAMPTZ values (which are also UTC internally).
 */
function effectiveTsBounds(
  fechaDesde:  string | null,
  fechaHasta:  string | null,
  horaDesde:   string,          // HH:MM
  horaHasta:   string,          // HH:MM — upper bound is EXCLUSIVE
  tzMode:      'local' | 'utc',
): { desdets: string | null; hastats: string | null } {
  // Argentina = UTC-3, no DST
  const TZ = tzMode === 'local' ? '-03:00' : 'Z'

  const desdets = fechaDesde ? `${fechaDesde}T${horaDesde}:00${TZ}` : null
  const hastats = fechaHasta ? `${fechaHasta}T${horaHasta}:00${TZ}` : null

  return { desdets, hastats }
}

/**
 * Parse a comma-separated filter param, accepting only whitelisted values.
 * Unknown values are silently dropped; returns an empty array when nothing valid.
 */
function parseFilterValues(raw: string | null, allowed: Set<string>): string[] {
  if (!raw) return []
  return raw.split(',').map(v => v.trim()).filter(v => allowed.has(v))
}

/**
 * Build an "AND (cond1 OR cond2 ...)" SQL fragment from a set of whitelisted
 * filter values and their static SQL condition strings.
 * Returns '' when values is empty (no condition appended).
 * The returned string contains ONLY pre-defined static SQL — no user input.
 */
function orClause(values: string[], map: Record<string, string>): string {
  const parts = values.map(v => map[v]).filter(Boolean)
  if (!parts.length) return ''
  const body = parts.length === 1 ? parts[0] : `(${parts.join('\n              OR ')})`
  return `\n          AND ${body}`
}

// ── GET /api/dashboard/casino/players ────────────────────────────────────────
//
// Query params:
//   agente            — exact match on agente (optional)
//   username          — case-insensitive partial match (optional)
//   seg_monto         — bajo | medio | alto | vip (optional)
//   seg_actividad     — nuevo | frecuente | regular | ocasional |
//                       en_riesgo | inactivo | perdido (optional)
//   valorRiesgo       — bajo | medio | critico, comma-separated (optional)
//                       Computed from seg_actividad + seg_monto — no join needed.
//   antiguedad        — nuevo | reciente | establecido | veterano | leal,
//                       comma-separated (optional)
//                       Computed from fecha_primera — no join needed.
//   dias_inactivo_min — integer ≥ 0: (CURRENT_DATE − fecha_ultima) ≥ N (optional)
//   dias_inactivo_max — integer ≥ 0: (CURRENT_DATE − fecha_ultima) ≤ N (optional)
//   fecha_desde       — YYYY-MM-DD: enables transaction-period mode (optional)
//   fecha_hasta       — YYYY-MM-DD: enables transaction-period mode (optional)
//   page              — 1-based, default 1
//   limit             — rows per page, default 100, max 500
//   sortBy            — one of SORT_COLS, default total_cargas
//   sortOrder         — asc | desc, default desc
//
// Modes:
//   With fecha_desde/hasta → aggregates from casino_transactions (period amounts).
//   Without               → uses casino_players totals (historical).
//
// Null-row behaviour for valorRiesgo / antiguedad:
//   - When filter is absent  → all rows included regardless of tags.
//   - When filter is present → rows that don't satisfy the condition are excluded.
//     In period mode, rows with no matching casino_players record are also excluded
//     (LEFT JOIN returns NULL for cp.* columns, conditions never match).

export async function GET(req: Request) {
  const err = await checkPermission(req, 'dashboard', 'read')
  if (err) return err

  const url = new URL(req.url)

  // ── Platform ────────────────────────────────────────────────────────────────
  const platformParam = url.searchParams.get('platform')?.trim() || 'zeus'
  if (!isValidPlatform(platformParam)) {
    return NextResponse.json(
      { error: `Plataforma inválida: "${platformParam}"` },
      { status: 400 },
    )
  }
  const agentsSql = getAgentsSqlArray(platformParam)

  // ── Existing filters ────────────────────────────────────────────────────────
  const agenteParam     = url.searchParams.get('agente')?.trim()      || null
  const usernameParam   = url.searchParams.get('username')?.trim()    || null
  const nivelParam      = url.searchParams.get('seg_monto')?.trim()   || null
  const fechaDesdeParam = url.searchParams.get('fecha_desde')?.trim() || null
  const fechaHastaParam = url.searchParams.get('fecha_hasta')?.trim() || null
  const segActividadParam = url.searchParams.get('seg_actividad')?.trim() || null

  const diasMinRaw   = url.searchParams.get('dias_inactivo_min')?.trim()
  const diasMaxRaw   = url.searchParams.get('dias_inactivo_max')?.trim()
  const diasMinParam = diasMinRaw ? parseInt(diasMinRaw, 10) : null
  const diasMaxParam = diasMaxRaw ? parseInt(diasMaxRaw, 10) : null

  if (
    (diasMinParam !== null && (isNaN(diasMinParam) || diasMinParam < 0)) ||
    (diasMaxParam !== null && (isNaN(diasMaxParam) || diasMaxParam < 0))
  ) {
    return NextResponse.json(
      { error: 'dias_inactivo_min and dias_inactivo_max must be non-negative integers' },
      { status: 400 },
    )
  }

  // ── Enum whitelist validation ───────────────────────────────────────────────
  if (nivelParam && !NIVEL_ALLOWED.has(nivelParam)) {
    return NextResponse.json(
      { error: `Invalid seg_monto "${nivelParam}": must be one of ${[...NIVEL_ALLOWED].join(', ')}` },
      { status: 400 },
    )
  }
  if (segActividadParam && !SEG_ACTIVIDAD_ALLOWED.has(segActividadParam)) {
    return NextResponse.json(
      { error: `Invalid seg_actividad "${segActividadParam}": must be one of ${[...SEG_ACTIVIDAD_ALLOWED].join(', ')}` },
      { status: 400 },
    )
  }

  // ── Date format validation ──────────────────────────────────────────────────
  if (fechaDesdeParam && !isValidDate(fechaDesdeParam)) {
    return NextResponse.json(
      { error: 'Invalid fecha_desde: expected YYYY-MM-DD' },
      { status: 400 },
    )
  }
  if (fechaHastaParam && !isValidDate(fechaHastaParam)) {
    return NextResponse.json(
      { error: 'Invalid fecha_hasta: expected YYYY-MM-DD' },
      { status: 400 },
    )
  }

  // ── Hora / timezone params ─────────────────────────────────────────────────
  const horaDesde = url.searchParams.get('hora_desde')?.trim() || '00:00'
  const horaHasta = url.searchParams.get('hora_hasta')?.trim() || '00:00'
  const tzModeRaw = url.searchParams.get('tz_mode')?.trim()    || 'local'
  const tzMode: 'local' | 'utc' = tzModeRaw === 'utc' ? 'utc' : 'local'

  const horaRegex = /^([01]\d|2[0-3]):[0-5]\d$/
  if (!horaRegex.test(horaDesde) || !horaRegex.test(horaHasta)) {
    return NextResponse.json(
      { error: 'hora_desde and hora_hasta must be in HH:MM format' },
      { status: 400 },
    )
  }

  // Date-level bounds (fallback for rows without fecha_hora_utc)
  const { desde: effectiveFechaDesde, hastaExclusive: effectiveFechaHasta } = effectiveDateBounds(
    fechaDesdeParam, fechaHastaParam, horaDesde, horaHasta, tzMode,
  )

  // Exact timestamp bounds (used for rows that have fecha_hora_utc — sub-day precision)
  const { desdets: effectiveTsDesde, hastats: effectiveTsHasta } = effectiveTsBounds(
    fechaDesdeParam, fechaHastaParam, horaDesde, horaHasta, tzMode,
  )

  // ── New tag-derived filters ─────────────────────────────────────────────────
  // Both are computed from casino_players fields — no join to contact_tags needed.
  const vrVals  = parseFilterValues(url.searchParams.get('valorRiesgo'),  VALOR_RIESGO_ALLOWED)
  const antVals = parseFilterValues(url.searchParams.get('antiguedad'),   ANTIGUEDAD_ALLOWED)

  // ── Pagination ──────────────────────────────────────────────────────────────
  const pageRaw  = parseInt(url.searchParams.get('page')  || '1',   10)
  const limitRaw = parseInt(url.searchParams.get('limit') || '100', 10)
  const pageParam  = isNaN(pageRaw)  ? 1   : Math.max(1, pageRaw)
  const limitParam = isNaN(limitRaw) ? 100 : Math.min(500, Math.max(1, limitRaw))
  const offset     = (pageParam - 1) * limitParam

  // ── Sort ────────────────────────────────────────────────────────────────────
  const rawSortBy  = url.searchParams.get('sortBy')?.trim()    || 'total_cargas'
  const rawOrder   = url.searchParams.get('sortOrder')?.trim() || 'desc'
  const sortCol    = SORT_COLS.has(rawSortBy) ? rawSortBy : 'total_cargas'
  const sortDir    = rawOrder === 'asc' ? 'ASC' : 'DESC'

  const hasFechaFilter = !!(fechaDesdeParam || fechaHastaParam)

  try {
    let rows:            CasinoJugador[]
    let total:           number
    let totalCargasSum:  number = 0
    let totalRetirosSum: number = 0
    let totalCantCargas: number = 0
    let totalCantRetiros: number = 0

    if (hasFechaFilter) {
      // ── Modo período: agrega transacciones del rango dado ─────────────────
      // Muestra montos reales del período (coincide con lo que muestra Zeus).
      // Une con casino_players solo para obtener segmentación y días sin mov.
      //
      // Date+time filtering strategy (dual-precision):
      //   Rows WITH fecha_hora_utc  → filtered by exact TIMESTAMPTZ bounds ($9/$10)
      //   Rows WITHOUT (NULL)       → filtered by date bounds ($2/$3) as before
      //
      // OVERINCLUSION RISK (NULL rows + non-default hora):
      //   When hora_desde or hora_hasta is not '00:00', rows where
      //   fecha_hora_utc IS NULL fall back to DATE-only filtering and are
      //   overinclusive: the entire day is included even if the entered hour
      //   would have excluded some transactions.
      //   When hora_desde = hora_hasta = '00:00' (the default), the DATE
      //   fallback is exact — there is no overinclusion.
      //
      // PRODUCTION READINESS CONDITION for exact hour-level parity:
      //   Run this SQL on the production DB before claiming Zeus parity with hora:
      //
      //   SELECT agente,
      //          COUNT(*) AS total,
      //          COUNT(fecha_hora_utc) AS with_ts,
      //          COUNT(*) - COUNT(fecha_hora_utc) AS null_ts,
      //          ROUND(100.0 * COUNT(fecha_hora_utc) / NULLIF(COUNT(*),0), 1) AS pct
      //   FROM casino_transactions
      //   WHERE agente = ANY('{bigwin,ofizeus,betcoin,royal,farabet}'::text[])
      //   GROUP BY agente ORDER BY pct;
      //
      //   Threshold: pct = 100.0 per agente (or ≥ 95.0 if residual rows are
      //   outside the queryable date range). Achieve 100% by running:
      //     node scripts/seed-casino-transactions.js
      //   after applying migration 031. The seed backfills fecha_hora_utc for
      //   all historical rows present in the captured files via DO UPDATE.
      //
      // Parameter order:
      //   $1  agente
      //   $2  fecha_desde_date (DATE, Argentina local, fallback for rows without TS)
      //   $3  fecha_hasta_date (DATE, exclusive, fallback for rows without TS)
      //   $4  username
      //   $5  seg_monto  $6  seg_actividad  $7  dias_min  $8  dias_max
      //   $9  ts_desde   (TIMESTAMPTZ, inclusive lower — for rows with fecha_hora_utc)
      //   $10 ts_hasta   (TIMESTAMPTZ, exclusive upper — for rows with fecha_hora_utc)
      //
      // valorRiesgo / antiguedad conditions are appended as static AND clauses.

      const periodParams: unknown[] = [
        agenteParam, effectiveFechaDesde, effectiveFechaHasta, usernameParam,
        nivelParam,  segActividadParam,   diasMinParam,         diasMaxParam,
        effectiveTsDesde, effectiveTsHasta,
      ]

      const ctePeriodo = `
        WITH periodo AS (
          SELECT
            ct.username,
            ct.agente,
            SUM(ct.monto) FILTER (WHERE ct.tipo = 'carga')::bigint   AS total_cargas,
            COUNT(*)      FILTER (WHERE ct.tipo = 'carga')::int       AS cant_cargas,
            SUM(ct.monto) FILTER (WHERE ct.tipo = 'retiro')::bigint  AS total_retiros,
            COUNT(*)      FILTER (WHERE ct.tipo = 'retiro')::int      AS cant_retiros
          FROM casino_transactions ct
          WHERE ct.agente = ANY(${agentsSql})
            AND ct.username != ct.agente          -- excluye Carga/Retiro indirecto
            AND ($1::text IS NULL OR ct.agente   = $1)
            AND ($4::text IS NULL OR ct.username ILIKE '%' || $4 || '%')
            -- Lower bound: precise TS for rows that have it, date fallback for old rows
            AND (
              $9::timestamptz IS NULL
              OR (ct.fecha_hora_utc IS NOT NULL AND ct.fecha_hora_utc >= $9::timestamptz)
              OR (ct.fecha_hora_utc IS NULL     AND ct.fecha           >= $2::date)
            )
            -- Upper bound (exclusive): same dual strategy
            AND (
              $10::timestamptz IS NULL
              OR (ct.fecha_hora_utc IS NOT NULL AND ct.fecha_hora_utc <  $10::timestamptz)
              OR (ct.fecha_hora_utc IS NULL     AND ct.fecha            < $3::date)
            )
          GROUP BY ct.username, ct.agente
          HAVING
            SUM(ct.monto) FILTER (WHERE ct.tipo = 'carga')  > 0
            OR SUM(ct.monto) FILTER (WHERE ct.tipo = 'retiro') > 0
        )
      `

      const joinAndWhere = `
        FROM periodo p
        LEFT JOIN casino_players cp
          ON LOWER(cp.username) = LOWER(p.username)
        WHERE ($5::text IS NULL OR cp.seg_monto     = $5)
          AND ($6::text IS NULL OR cp.seg_actividad = $6)
          AND ($7::int  IS NULL OR (cp.fecha_ultima IS NOT NULL
               AND (CURRENT_DATE - cp.fecha_ultima) >= $7))
          AND ($8::int  IS NULL OR (cp.fecha_ultima IS NOT NULL
               AND (CURRENT_DATE - cp.fecha_ultima) <= $8))${orClause(vrVals, VR_PERIOD)}${orClause(antVals, ANT_PERIOD)}
      `

      const [dataRows, countRows] = await Promise.all([
        query<CasinoJugador>(
          `${ctePeriodo}
           SELECT
             p.username,
             p.agente,
             COALESCE(cp.seg_monto,     '') AS seg_monto,
             COALESCE(cp.seg_actividad, '') AS seg_actividad,
             COALESCE(p.total_cargas,  0)   AS total_cargas,
             COALESCE(p.cant_cargas,   0)   AS cant_cargas,
             COALESCE(p.total_retiros, 0)   AS total_retiros,
             COALESCE(p.cant_retiros,  0)   AS cant_retiros,
             (COALESCE(p.total_cargas, 0) - COALESCE(p.total_retiros, 0))::bigint AS neto,
             CASE WHEN cp.fecha_ultima IS NOT NULL
               THEN (CURRENT_DATE - cp.fecha_ultima)::int
             END                            AS dias_ultimo,
             cp.fecha_ultima::text,
             COALESCE(cp.labels, '{}')                AS labels,
             CASE
               WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
                    AND cp.seg_monto IN ('super_vip','vip') THEN 'critico'
               WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
                    AND cp.seg_monto = 'medio'         THEN 'medio'
               WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
                    AND cp.seg_monto = 'bajo'          THEN 'bajo'
               ELSE NULL
             END AS valor_riesgo,
             CASE
               WHEN cp.fecha_primera IS NULL                                 THEN NULL
               WHEN (CURRENT_DATE - cp.fecha_primera) <   30                THEN 'nuevo'
               WHEN (CURRENT_DATE - cp.fecha_primera) <   90                THEN 'reciente'
               WHEN (CURRENT_DATE - cp.fecha_primera) <  150                THEN 'establecido'
               WHEN (CURRENT_DATE - cp.fecha_primera) <  270                THEN 'veterano'
               ELSE                                                               'leal'
             END AS antiguedad
           ${joinAndWhere}
           ORDER BY ${sortCol} ${sortDir}
           LIMIT $11 OFFSET $12`,
          [...periodParams, limitParam, offset],
        ),
        query<{ total: number; total_cargas_sum: string; total_retiros_sum: string; total_cant_cargas: number; total_cant_retiros: number }>(
          `${ctePeriodo}
           SELECT
             COUNT(*)::int                                        AS total,
             COALESCE(SUM(p.total_cargas),  0)::bigint           AS total_cargas_sum,
             COALESCE(SUM(p.total_retiros), 0)::bigint           AS total_retiros_sum,
             COALESCE(SUM(p.cant_cargas),   0)::int              AS total_cant_cargas,
             COALESCE(SUM(p.cant_retiros),  0)::int              AS total_cant_retiros
           ${joinAndWhere}`,
          periodParams,
        ),
      ])

      rows             = dataRows
      total            = countRows[0]?.total            ?? 0
      totalCargasSum   = Number(countRows[0]?.total_cargas_sum  ?? 0)
      totalRetirosSum  = Number(countRows[0]?.total_retiros_sum ?? 0)
      totalCantCargas  = countRows[0]?.total_cant_cargas  ?? 0
      totalCantRetiros = countRows[0]?.total_cant_retiros ?? 0

    } else {
      // ── Modo histórico: usa totales acumulados de casino_players ──────────
      // Sin filtro de fecha → muestra toda la historia del jugador.
      //
      // Parameter order:
      //   $1 agente  $2 username  $3 seg_monto  $4 seg_actividad
      //   $5 dias_min  $6 dias_max
      //
      // valorRiesgo / antiguedad conditions are appended as static AND clauses
      // (no extra parameters).

      const histParams: unknown[] = [
        agenteParam, usernameParam, nivelParam, segActividadParam,
        diasMinParam, diasMaxParam,
      ]

      const histWhere = `
        WHERE agente = ANY(${agentsSql})
          AND ($1::text IS NULL OR agente        = $1)
          AND ($2::text IS NULL OR username      ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR seg_monto     = $3)
          AND ($4::text IS NULL OR seg_actividad = $4)
          AND ($5::int  IS NULL OR (fecha_ultima IS NOT NULL
               AND (CURRENT_DATE - fecha_ultima) >= $5))
          AND ($6::int  IS NULL OR (fecha_ultima IS NOT NULL
               AND (CURRENT_DATE - fecha_ultima) <= $6))${orClause(vrVals, VR_HIST)}${orClause(antVals, ANT_HIST)}
      `

      const [dataRows, countRows] = await Promise.all([
        query<CasinoJugador>(
          `SELECT
             username,
             agente,
             COALESCE(seg_monto,     '') AS seg_monto,
             COALESCE(seg_actividad, '') AS seg_actividad,
             total_cargas::bigint        AS total_cargas,
             cant_cargas,
             total_retiros::bigint       AS total_retiros,
             cant_retiros,
             (total_cargas - total_retiros)::bigint AS neto,
             CASE WHEN fecha_ultima IS NOT NULL
               THEN (CURRENT_DATE - fecha_ultima)::int
             END                         AS dias_ultimo,
             fecha_ultima::text,
             COALESCE(labels, '{}')      AS labels,
             CASE
               WHEN seg_actividad IN ('perdido','inactivo','en_riesgo')
                    AND seg_monto IN ('super_vip','vip') THEN 'critico'
               WHEN seg_actividad IN ('perdido','inactivo','en_riesgo')
                    AND seg_monto = 'medio'         THEN 'medio'
               WHEN seg_actividad IN ('perdido','inactivo','en_riesgo')
                    AND seg_monto = 'bajo'          THEN 'bajo'
               ELSE NULL
             END AS valor_riesgo,
             CASE
               WHEN fecha_primera IS NULL                               THEN NULL
               WHEN (CURRENT_DATE - fecha_primera) <   30              THEN 'nuevo'
               WHEN (CURRENT_DATE - fecha_primera) <   90              THEN 'reciente'
               WHEN (CURRENT_DATE - fecha_primera) <  150              THEN 'establecido'
               WHEN (CURRENT_DATE - fecha_primera) <  270              THEN 'veterano'
               ELSE                                                          'leal'
             END AS antiguedad
           FROM casino_players
           ${histWhere}
           ORDER BY ${sortCol} ${sortDir}
           LIMIT $7 OFFSET $8`,
          [...histParams, limitParam, offset],
        ),
        query<{ total: number; total_cargas_sum: string; total_retiros_sum: string; total_cant_cargas: number; total_cant_retiros: number }>(
          `SELECT
             COUNT(*)::int                                        AS total,
             COALESCE(SUM(total_cargas),  0)::bigint             AS total_cargas_sum,
             COALESCE(SUM(total_retiros), 0)::bigint             AS total_retiros_sum,
             COALESCE(SUM(cant_cargas),   0)::int                AS total_cant_cargas,
             COALESCE(SUM(cant_retiros),  0)::int                AS total_cant_retiros
           FROM casino_players
           ${histWhere}`,
          histParams,
        ),
      ])

      rows             = dataRows
      total            = countRows[0]?.total            ?? 0
      totalCargasSum   = Number(countRows[0]?.total_cargas_sum  ?? 0)
      totalRetirosSum  = Number(countRows[0]?.total_retiros_sum ?? 0)
      totalCantCargas  = countRows[0]?.total_cant_cargas  ?? 0
      totalCantRetiros = countRows[0]?.total_cant_retiros ?? 0
    }

    return NextResponse.json({
      jugadores:          rows,
      total,
      page:               pageParam,
      limit:              limitParam,
      total_cargas_sum:   totalCargasSum,
      total_retiros_sum:  totalRetirosSum,
      total_cant_cargas:  totalCantCargas,
      total_cant_retiros: totalCantRetiros,
    } satisfies CasinoJugadoresResponse)

  } catch (e) {
    console.error('[/api/dashboard/casino/players GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
