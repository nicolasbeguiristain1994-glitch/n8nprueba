/**
 * logger.ts — UserPrioritization
 *
 * Logger estructurado JSON para el módulo de priorización de contactos.
 * Sigue el mismo patrón que contact-frequency/logger.ts para consistencia.
 *
 * ## Formato de salida (una línea JSON por evento):
 * {
 *   "timestamp": "2026-05-16T10:00:00.000Z",
 *   "level": "info",
 *   "event": "prioritization_recompute_start",
 *   "run_id": "uuid",
 *   "instance_id": "hostname"
 * }
 *
 * ## Eventos registrados
 * - prioritization_recompute_start  → inicio de corrida (run_id, instance_id)
 * - prioritization_recompute_batch  → por batch (batch_num, batch_size, total_processed)
 * - prioritization_recompute_end    → fin de corrida (status, processed, eligible, duration_ms)
 * - prioritization_recompute_error  → stderr cuando el recompute falla o es revocado
 *
 * ## Cómo leer los logs en Railway
 * Logs → filtrar por: `prioritization_recompute`
 *
 * ## Garantía de no-throw
 * Todas las funciones capturan sus propios errores.
 * Un fallo del logger nunca detiene el flujo de recompute.
 */

// ── Tipos internos ────────────────────────────────────────────────────────────

export interface RecomputeStartLog {
  run_id:      string
  instance_id: string
  batch_size:  number
}

export interface RecomputeBatchLog {
  run_id:           string
  batch_num:        number
  batch_size:       number
  total_processed:  number
}

export interface RecomputeEndLog {
  run_id:      string
  status:      'success' | 'failed' | 'revoked'
  processed:   number
  eligible:    number
  skipped:     number
  duration_ms: number
}

export interface RecomputeErrorLog {
  run_id:  string
  status:  'failed' | 'revoked'
  error:   string
}

// ── Funciones públicas ────────────────────────────────────────────────────────

export function logRecomputeStart(entry: RecomputeStartLog): void {
  emit('info', 'prioritization_recompute_start', entry)
}

export function logRecomputeBatch(entry: RecomputeBatchLog): void {
  emit('info', 'prioritization_recompute_batch', entry)
}

export function logRecomputeEnd(entry: RecomputeEndLog): void {
  const level = entry.status === 'success' ? 'info' : 'warn'
  emit(level, 'prioritization_recompute_end', entry)
}

export function logRecomputeError(entry: RecomputeErrorLog): void {
  try {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level:     'error',
      event:     'prioritization_recompute_error',
      ...entry,
    })
    process.stderr.write(line + '\n')
  } catch { /* garantía de no-throw */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emit(level: 'info' | 'warn', event: string, data: object): void {
  try {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...data,
    })
    process.stdout.write(line + '\n')
  } catch { /* garantía de no-throw */ }
}
