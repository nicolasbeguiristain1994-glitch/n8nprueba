'use strict'

/**
 * Fechas del sync en hora Argentina (UTC−3, sin horario de verano).
 *
 * Los conectores trabajan con días locales: `fecha` en casino_transactions es la
 * fecha argentina y Zeus/Bet30 reciben rangos [desde 00:00, hasta+1 00:00) en -03.
 * Todo cálculo de "hoy" o de "día cerrado" tiene que usar la misma referencia; si
 * se mezcla con la fecha UTC, entre las 21:00 y las 24:00 ART el sync cree que ya
 * es mañana.
 */

const AR_OFFSET_MS = 3 * 3_600_000
const DATE_RE      = /^\d{4}-\d{2}-\d{2}$/

/** true si `s` es una fecha YYYY-MM-DD real (rechaza 2026-02-30). */
function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Fecha argentina (YYYY-MM-DD) del instante dado. */
function argToday(now = new Date()) {
  return new Date(now.getTime() - AR_OFFSET_MS).toISOString().slice(0, 10)
}

/** Suma `n` días (puede ser negativo) a una fecha YYYY-MM-DD. */
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * Último día argentino que ya había terminado cuando empezó el fetch.
 * Un día D solo queda cubierto por completo si el fetch empezó después de
 * D+1 00:00 ART; lo que se pidió antes puede estar incompleto.
 */
function lastClosedDay(fetchStartedAt) {
  return addDays(argToday(fetchStartedAt), -1)
}

function minDate(a, b) { return a <= b ? a : b }
function maxDate(a, b) { return a >= b ? a : b }

/** Cantidad de días de `desde` a `hasta`, ambos inclusive. */
function daysInclusive(desde, hasta) {
  const ms = new Date(`${hasta}T12:00:00Z`) - new Date(`${desde}T12:00:00Z`)
  return Math.round(ms / 86_400_000) + 1
}

/**
 * Divide [desde, hasta] en tramos consecutivos de a lo sumo `chunkDays` días.
 * Devuelve un solo tramo cuando el rango entra entero.
 */
function buildDateChunks(desde, hasta, chunkDays) {
  const chunks = []
  let cursor   = desde

  while (cursor <= hasta) {
    const tentativeEnd = addDays(cursor, chunkDays - 1)
    const chunkEnd     = minDate(tentativeEnd, hasta)
    chunks.push({ desde: cursor, hasta: chunkEnd })
    cursor = addDays(chunkEnd, 1)
  }

  return chunks
}

module.exports = {
  isValidDate,
  argToday,
  addDays,
  lastClosedDay,
  minDate,
  maxDate,
  daysInclusive,
  buildDateChunks,
}
