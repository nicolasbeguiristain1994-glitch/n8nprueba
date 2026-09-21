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

module.exports = {
  DEFAULT_OFFSET_HOURS,
  fmtDate,
  addOneDay,
  utcToLocalDate,
  extractUtcTimestamp,
}
