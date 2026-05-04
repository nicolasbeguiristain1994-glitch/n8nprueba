/**
 * metrics.ts — ContactFrequencyEngine
 *
 * Contadores en memoria para el motor de frecuencia.
 *
 * ## Limitación importante
 * Los contadores se resetean con cada deploy o restart del proceso.
 * Son útiles para monitoreo en tiempo real y alertas inmediatas,
 * no para históricos. Los logs JSON son la fuente de verdad a largo plazo.
 *
 * ## Acceso
 * GET /api/metrics/frequency → snapshot JSON
 *
 * ## Con múltiples instancias (Railway scale-out)
 * Cada instancia tiene sus propios contadores. El endpoint devuelve
 * solo los datos de la instancia que responde. Para agregación entre
 * instancias, usar los logs (Loki/Datadog) o migrar a Redis.
 *
 * ## Percentiles de duración
 * Se mantienen las últimas DURATION_SAMPLE_SIZE muestras (circular buffer).
 * Con 5.000–10.000 envíos/día, 2.000 muestras cubren ~20-40 minutos de ventana.
 */

// ── Constantes ────────────────────────────────────────────────────────────────

/** Tamaño máximo del buffer circular de duraciones. */
const DURATION_SAMPLE_SIZE = 2_000

// ── Estado interno ────────────────────────────────────────────────────────────

const startedAt = new Date().toISOString()

const counters = {
  allow:  0,
  delay:  0,
  block:  0,
  errors: 0,
}

/** Buffer circular de duraciones (ms) para percentiles. */
const durations: number[] = []

// ── Funciones de registro ─────────────────────────────────────────────────────

/**
 * Registra una decisión y su duración.
 * Llamar después de cada evaluación exitosa.
 */
export function recordDecision(
  decision:   'ALLOW' | 'DELAY' | 'BLOCK',
  durationMs: number,
): void {
  try {
    if      (decision === 'ALLOW') counters.allow++
    else if (decision === 'DELAY') counters.delay++
    else                           counters.block++

    // Buffer circular: descarta la muestra más vieja cuando llega al límite
    if (durations.length >= DURATION_SAMPLE_SIZE) durations.shift()
    durations.push(durationMs)
  } catch { /* garantía de no-throw */ }
}

/**
 * Registra un error del motor (fallo de transacción, advisory lock, etc.).
 */
export function recordError(): void {
  try { counters.errors++ } catch { /* garantía de no-throw */ }
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

/**
 * Devuelve un snapshot inmutable de todas las métricas actuales.
 * Usado por el endpoint GET /api/metrics/frequency.
 */
export function getMetricsSnapshot() {
  const total = counters.allow + counters.delay + counters.block

  // Percentiles de duración
  const sorted = [...durations].sort((a, b) => a - b)
  const pct = (p: number) => sorted[Math.floor(sorted.length * p)] ?? 0
  const avg = sorted.length > 0
    ? Math.round(sorted.reduce((sum, d) => sum + d, 0) / sorted.length)
    : 0

  return {
    // Metadatos
    generated_at:  new Date().toISOString(),
    process_start: startedAt,

    // Contadores absolutos
    decisions_total: {
      allow:  counters.allow,
      delay:  counters.delay,
      block:  counters.block,
      total,
    },

    // Tasas derivadas (NaN-safe)
    rates: {
      block_pct:  total > 0 ? +((counters.block / total) * 100).toFixed(1) : 0,
      delay_pct:  total > 0 ? +((counters.delay / total) * 100).toFixed(1) : 0,
      allow_pct:  total > 0 ? +((counters.allow / total) * 100).toFixed(1) : 0,
    },

    // Latencia de evaluación (ms)
    duration_ms: {
      p50:    pct(0.50),
      p95:    pct(0.95),
      p99:    pct(0.99),
      avg,
      sample: sorted.length,
    },

    // Errores del motor
    errors_total: counters.errors,
  }
}
