'use strict'

const { addDays, lastClosedDay, minDate, maxDate } = require('./dates')

/**
 * Cursor de sync por plataforma y agente.
 *
 * Forma: `{ coveredFrom, coveredThrough }` (YYYY-MM-DD, hora Argentina) o `null`.
 * Representa el último tramo CONTIGUO de días cerrados sincronizados con éxito.
 *
 * Reglas:
 *   - Solo cuentan días que ya habían terminado al empezar el fetch. El día en
 *     curso nunca queda "cubierto": se vuelve a pedir en la corrida siguiente.
 *   - Un rango exitoso que toca o se solapa con el tramo lo extiende.
 *   - Un rango exitoso disjunto NO lo mueve: saltaría el hueco del medio.
 *   - Un fallo no llama a esta función: el cursor queda donde estaba.
 */

/**
 * @param {{coveredFrom: string, coveredThrough: string}|null} cursor
 * @param {{desde: string, hasta: string, fetchStartedAt: Date}} range
 * @returns {{cursor: object|null, moved: boolean, reason: string}}
 */
function advanceCursor(cursor, { desde, hasta, fetchStartedAt }) {
  const closedHasta = minDate(hasta, lastClosedDay(fetchStartedAt))

  if (closedHasta < desde) {
    return { cursor, moved: false, reason: 'no_closed_days' }
  }

  if (!cursor) {
    return {
      cursor: { coveredFrom: desde, coveredThrough: closedHasta },
      moved:  true,
      reason: 'established',
    }
  }

  const contiguous =
    desde <= addDays(cursor.coveredThrough, 1) &&
    closedHasta >= addDays(cursor.coveredFrom, -1)

  if (!contiguous) {
    return { cursor, moved: false, reason: 'disjoint' }
  }

  const next = {
    coveredFrom:    minDate(cursor.coveredFrom, desde),
    coveredThrough: maxDate(cursor.coveredThrough, closedHasta),
  }
  const moved =
    next.coveredFrom    !== cursor.coveredFrom ||
    next.coveredThrough !== cursor.coveredThrough

  return { cursor: next, moved, reason: moved ? 'extended' : 'already_covered' }
}

/**
 * Rango a pedir en modo --auto.
 *
 * Arranca `overlapDays` días antes del primer día no cubierto: con overlap=1 se
 * vuelve a pedir el último día cerrado (movimientos que la API expone tarde) y
 * todo lo que sigue hasta hoy. La dedup por ID y el recompute hacen que repetir
 * días no altere ningún total.
 *
 * Sin cursor no se adivina un inicio: hace falta un bootstrap explícito.
 *
 * @returns {{desde: string, hasta: string}|{error: 'CURSOR_MISSING'}}
 */
function resolveAutoRange(cursor, { today, overlapDays = 1, bootstrapDesde = null }) {
  if (!cursor) {
    if (!bootstrapDesde) return { error: 'CURSOR_MISSING' }
    return { desde: minDate(bootstrapDesde, today), hasta: today }
  }

  const firstUncovered = addDays(cursor.coveredThrough, 1)
  const desde          = maxDate(addDays(firstUncovered, -overlapDays), cursor.coveredFrom)

  return { desde: minDate(desde, today), hasta: today }
}

module.exports = { advanceCursor, resolveAutoRange }
