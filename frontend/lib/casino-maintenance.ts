import { NextResponse } from 'next/server'

/**
 * Pausa operativa del sync de casino (equivalente de
 * src/casino-connectors/sync/maintenance.js, mismas reglas).
 *
 *   CASINO_SYNC_PAUSED=1   → pausado
 *   CASINO_SYNC_PAUSED=0   → comportamiento normal (igual que sin definir)
 *
 * Sin definir, vacío, "0" o "false" (sin distinguir mayúsculas, ignorando
 * espacios) no pausan. Cualquier otro valor no vacío pausa: una configuración
 * desconocida falla cerrada.
 *
 * Bloquea solo los disparadores de escritura de casino (sync, diagnóstico de
 * sync, re-segmentación, migraciones de la app). Las lecturas
 * siguen funcionando. No cancela procesos que ya estaban corriendo.
 */

export const CASINO_SYNC_PAUSED_ENV  = 'CASINO_SYNC_PAUSED'
export const CASINO_SYNC_PAUSED_CODE = 'CASINO_SYNC_PAUSED'
export const CASINO_SYNC_PAUSED_MESSAGE =
  'Las operaciones de sincronización y mantenimiento de casino están pausadas temporalmente.'

const NOT_PAUSED_VALUES = new Set(['', '0', 'false'])

export function isCasinoSyncPaused(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[CASINO_SYNC_PAUSED_ENV]
  if (raw === undefined) return false
  return !NOT_PAUSED_VALUES.has(raw.trim().toLowerCase())
}

/** 503 uniforme para los disparadores pausados. No expone configuración. */
export function casinoSyncPausedResponse(): NextResponse {
  return NextResponse.json(
    { error: CASINO_SYNC_PAUSED_MESSAGE, code: CASINO_SYNC_PAUSED_CODE },
    { status: 503 },
  )
}
