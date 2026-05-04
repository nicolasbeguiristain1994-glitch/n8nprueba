/**
 * logger.ts — ContactFrequencyEngine
 *
 * Logger estructurado JSON para el motor de frecuencia.
 *
 * ## Por qué JSON puro
 * Railway captura stdout y lo envía a su log viewer. El formato JSON permite
 * que herramientas como Fluent Bit, Loki, Datadog o Papertrail lo parseen
 * automáticamente sin configuración adicional.
 *
 * ## Cómo leer los logs en Railway
 * Logs → filtrar por: `frequency_decision` o `frequency_error`
 *
 * ## Formato de salida
 * Una línea JSON por decisión:
 * {
 *   "timestamp": "2026-05-04T14:30:00.123Z",
 *   "level": "info",
 *   "event": "frequency_decision",
 *   "contact_id": "uuid",
 *   "operator_id": "uuid | null",
 *   "campaign_id": "uuid | null",
 *   "decision": "ALLOW | DELAY | BLOCK",
 *   "risk_score": 0,
 *   "reason": "Score 0 — dentro de límites...",
 *   "duration_ms": 18,
 *   "rule_id": "uuid"
 * }
 *
 * ## Garantía de no-throw
 * Todas las funciones capturan sus propios errores internamente.
 * Un fallo del logger nunca detiene el flujo de envío.
 */

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface FrequencyDecisionLog {
  contact_id:  string
  operator_id: string | null
  campaign_id: string | undefined
  decision:    'ALLOW' | 'DELAY' | 'BLOCK'
  risk_score:  number
  reason:      string
  duration_ms: number
  rule_id:     string
  atomic:      boolean
}

export interface FrequencyErrorLog {
  contact_id:  string
  operator_id: string | null
  campaign_id: string | undefined
  error:       string
  phase:       'transaction' | 'advisory_lock' | 'profile_read' | 'rule_resolve' | 'record_send' | 'unknown'
}

// ── Funciones públicas ────────────────────────────────────────────────────────

/**
 * Registra una decisión de frecuencia como línea JSON en stdout.
 *
 * level:
 *   - ALLOW  → "info"
 *   - DELAY  → "warn"  (riesgo moderado, útil para alertas)
 *   - BLOCK  → "warn"  (contacto bloqueado, esperado pero importante)
 */
export function logFrequencyDecision(entry: FrequencyDecisionLog): void {
  try {
    const level = entry.decision === 'ALLOW' ? 'info' : 'warn'
    const line = JSON.stringify({
      timestamp:   new Date().toISOString(),
      level,
      event:       'frequency_decision',
      contact_id:  entry.contact_id,
      operator_id: entry.operator_id,
      campaign_id: entry.campaign_id ?? null,
      decision:    entry.decision,
      risk_score:  entry.risk_score,
      reason:      entry.reason,
      duration_ms: entry.duration_ms,
      rule_id:     entry.rule_id,
      atomic:      entry.atomic,
    })
    // Usar process.stdout.write para evitar el prefijo que Next.js agrega a console.log
    // y garantizar una línea por entrada (sin newline extra).
    process.stdout.write(line + '\n')
  } catch { /* garantía de no-throw */ }
}

/**
 * Registra un error del motor como línea JSON en stderr.
 * Siempre level "error".
 */
export function logFrequencyError(entry: FrequencyErrorLog): void {
  try {
    const line = JSON.stringify({
      timestamp:   new Date().toISOString(),
      level:       'error',
      event:       'frequency_error',
      contact_id:  entry.contact_id,
      operator_id: entry.operator_id,
      campaign_id: entry.campaign_id ?? null,
      error:       entry.error,
      phase:       entry.phase,
    })
    process.stderr.write(line + '\n')
  } catch { /* garantía de no-throw */ }
}
