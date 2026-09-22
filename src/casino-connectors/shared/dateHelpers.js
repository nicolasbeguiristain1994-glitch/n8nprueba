'use strict'

/**
 * Date helpers shared by casino connectors whose upstream panels report times
 * in a fixed UTC offset (no DST) — Zeus, Bet30, and (per the sync plan) Argenbet
 * and Ganamos all operate on Argentina time. Extracted from ZeusConnector so the
 * next connectors don't reimplement the same UTC<->local math.
 */

const DEFAULT_OFFSET_HOURS = 3 // Argentina = UTC-3, no DST

// Zeus-style APIs expect "YYYY-MM-DD HH:MM:SS" — URLSearchParams encodes space as +
function fmtDate(d) {
  return `${d} 00:00:00`
}

// Adds one day to a YYYY-MM-DD string (noon UTC avoids DST edge cases)
function addOneDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().substring(0, 10)
}

// Converts a UTC timestamp string to the local calendar date (YYYY-MM-DD) for a
// fixed-offset timezone (default: Argentina, UTC-3). A 22:00 ART transaction is
// 01:00 UTC the next day — substring(0,10) on the raw UTC value would be wrong.
function utcToLocalDate(fechaStr, offsetHours = DEFAULT_OFFSET_HOURS) {
  if (!fechaStr) return null
  const d = new Date(fechaStr)
  if (isNaN(d.getTime())) {
    return typeof fechaStr === 'string' ? fechaStr.substring(0, 10) : null
  }
  return new Date(d.getTime() - offsetHours * 3_600_000).toISOString().substring(0, 10)
}

// Returns a clean ISO UTC string only when the raw value has a time component.
function extractUtcTimestamp(fechaStr) {
  if (!fechaStr) return null
  if (!fechaStr.includes('T') && !fechaStr.includes(' ')) return null
  const d = new Date(fechaStr)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}

const PLAIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Formats a UTC instant (Date, epoch millis, or ISO string) as the
// "YYYY-MM-DD HH:MM:SS" the Zeus-style API expects, in a fixed-offset local
// timezone (default Argentina, UTC-3). Used for exact-timestamp incremental
// windows (fase 4, D4) where a plain calendar date is not precise enough —
// building this with `date.toISOString() + ' 00:00:00'` (string concatenation
// of a UTC ISO stamp) would silently ignore both the UTC->local offset and the
// actual time-of-day, always landing on local midnight regardless of the real
// instant. This does neither: it shifts by the offset first, then formats.
function toLocalDateTimeString(value, offsetHours = DEFAULT_OFFSET_HOURS) {
  const d = value instanceof Date ? value : new Date(value)
  if (isNaN(d.getTime())) {
    throw new Error(`dateHelpers.toLocalDateTimeString: unparsable value: ${JSON.stringify(value)}`)
  }
  const local = new Date(d.getTime() - offsetHours * 3_600_000)
  const iso   = local.toISOString() // "YYYY-MM-DDTHH:MM:SS.sssZ"
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}

/**
 * Builds the `{ startDate, endDate }` pair a Zeus-style API expects, from
 * either plain `YYYY-MM-DD` dates (day-level, inclusive/exclusive as before —
 * `hasta` bumped one day) or exact ISO timestamps (fase 4 incremental sync,
 * e.g. `MAX(fecha_hora_utc) - 30min`), which are used exactly as given — no
 * day-boundary padding, since the caller already picked the precise boundary.
 * Mixed inputs (one plain, one exact) are supported independently.
 */
function buildApiDateRange(desde, hasta, offsetHours = DEFAULT_OFFSET_HOURS) {
  const desdeIsPlainDate = PLAIN_DATE_RE.test(String(desde))
  const hastaIsPlainDate = PLAIN_DATE_RE.test(String(hasta))

  const startDate = desdeIsPlainDate ? fmtDate(desde) : toLocalDateTimeString(desde, offsetHours)
  const endDate   = hastaIsPlainDate ? fmtDate(addOneDay(hasta)) : toLocalDateTimeString(hasta, offsetHours)

  return { startDate, endDate }
}

module.exports = {
  DEFAULT_OFFSET_HOURS,
  fmtDate,
  addOneDay,
  utcToLocalDate,
  extractUtcTimestamp,
  toLocalDateTimeString,
  buildApiDateRange,
}
