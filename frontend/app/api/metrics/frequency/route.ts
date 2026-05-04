/**
 * GET /api/metrics/frequency
 *
 * Expone un snapshot de las métricas del ContactFrequencyEngine.
 * Protegido por Bearer Token + Rate Limiting.
 *
 * ## Autenticación
 *   Requiere: Authorization: Bearer <METRICS_API_TOKEN>
 *   El token se configura como variable de entorno en Railway.
 *
 * ## Uso correcto
 *   curl -H "Authorization: Bearer TU_TOKEN" \
 *        https://tu-app.railway.app/api/metrics/frequency
 *
 * ## Códigos de respuesta
 *   200 — snapshot de métricas en JSON
 *   401 — token inválido, ausente o no configurado
 *   429 — demasiadas requests (> 60/min por IP)
 *
 * ## Ejemplo de respuesta 200
 * {
 *   "generated_at": "2026-05-04T14:30:00.123Z",
 *   "process_start": "2026-05-04T12:00:00.000Z",
 *   "decisions_total": { "allow": 842, "delay": 31, "block": 127, "total": 1000 },
 *   "rates": { "block_pct": 12.7, "delay_pct": 3.1, "allow_pct": 84.2 },
 *   "duration_ms": { "p50": 18, "p95": 42, "p99": 67, "avg": 21, "sample": 1000 },
 *   "errors_total": 0
 * }
 *
 * ## Alertas recomendadas
 *   block_pct > 30%       → campaña con contactos duplicados en múltiples listas
 *   errors_total > 0      → motor fallando, envíos sin control de frecuencia
 *   duration_ms.p95 > 200 → contención en advisory locks, revisar concurrencia
 */

import { NextRequest, NextResponse } from 'next/server'
import { getMetricsSnapshot }        from '@/lib/contact-frequency/metrics'
import {
  checkRateLimit,
  authenticateBearer,
  getClientIp,
  buildRateLimitHeaders,
} from '@/lib/security/api-protection'

export const dynamic = 'force-dynamic'  // nunca cachear — siempre datos en tiempo real

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)

  // ── 1. Rate limiting (antes de auth para prevenir fuerza bruta) ──────────────
  const rl = checkRateLimit(ip, 60, 60_000)
  const rlHeaders = buildRateLimitHeaders(rl)

  if (!rl.allowed) {
    const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000)
    return NextResponse.json(
      { error: 'Too Many Requests', retry_after_seconds: retryAfter },
      {
        status:  429,
        headers: { ...rlHeaders, 'Retry-After': String(retryAfter) },
      },
    )
  }

  // ── 2. Autenticación Bearer ──────────────────────────────────────────────────
  const auth = authenticateBearer(req, 'METRICS_API_TOKEN')

  if (!auth.ok) {
    // Loguear el intento fallido con IP (sin incluir el token provisto)
    process.stdout.write(JSON.stringify({
      timestamp:   new Date().toISOString(),
      level:       'warn',
      event:       'metrics_auth_failed',
      ip,
      reason:      auth.reason,
    }) + '\n')

    // Mismo mensaje genérico para todos los casos de fallo:
    // no revelar si el token existe, no existe, o está mal formateado.
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: rlHeaders },
    )
  }

  // ── 3. Respuesta ──────────────────────────────────────────────────────────────
  const snapshot = getMetricsSnapshot()
  return NextResponse.json(snapshot, { headers: rlHeaders })
}
