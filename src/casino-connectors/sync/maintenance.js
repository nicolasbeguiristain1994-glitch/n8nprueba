'use strict'

/**
 * Pausa operativa del sync de casino.
 *
 *   CASINO_SYNC_PAUSED=1   → pausado: no se inicia ninguna corrida nueva
 *   CASINO_SYNC_PAUSED=0   → comportamiento normal (igual que sin definir)
 *
 * Sin definir, vacío, "0" o "false" (sin distinguir mayúsculas, ignorando
 * espacios) permiten el comportamiento existente. CUALQUIER otro valor no vacío
 * pausa: una configuración desconocida ("no", "off", "pausa") falla cerrada.
 *
 * La pausa solo bloquea INICIOS nuevos. No cancela corridas que ya estaban en
 * curso ni afecta lecturas (Monitoreo, dashboard).
 *
 * Equivalente frontend: frontend/lib/casino-maintenance.ts (mismas reglas).
 */

const CASINO_SYNC_PAUSED_ENV  = 'CASINO_SYNC_PAUSED'
const CASINO_SYNC_PAUSED_CODE = 'CASINO_SYNC_PAUSED'
const CASINO_SYNC_PAUSED_MESSAGE =
  'La sincronización de casino está pausada por mantenimiento (CASINO_SYNC_PAUSED); no se inició ninguna corrida.'

const NOT_PAUSED_VALUES = new Set(['', '0', 'false'])

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
function isCasinoSyncPaused(env = process.env) {
  const raw = env ? env[CASINO_SYNC_PAUSED_ENV] : undefined
  if (raw === undefined || raw === null) return false
  return !NOT_PAUSED_VALUES.has(String(raw).trim().toLowerCase())
}

module.exports = {
  isCasinoSyncPaused,
  CASINO_SYNC_PAUSED_ENV,
  CASINO_SYNC_PAUSED_CODE,
  CASINO_SYNC_PAUSED_MESSAGE,
}
