/**
 * api-protection.ts
 *
 * Utilidades reutilizables de seguridad para API routes internas.
 *
 * ## Funciones exportadas
 *
 * ### checkRateLimit(ip, options?)
 *   Sliding-window rate limiter en memoria. Retorna un objeto con `allowed`
 *   y headers listos para incluir en la respuesta (`X-RateLimit-*`).
 *   Aplicar ANTES de la autenticación para prevenir fuerza bruta.
 *
 * ### authenticateBearer(req)
 *   Valida el header `Authorization: Bearer <token>` contra la variable de
 *   entorno indicada. Usa comparación en tiempo constante para evitar
 *   timing attacks. Retorna `{ ok: true }` o `{ ok: false, reason: string }`.
 *
 * ## Uso típico en un route handler
 *
 *   export async function GET(req: NextRequest) {
 *     const rl = checkRateLimit(getClientIp(req))
 *     if (!rl.allowed) return rateLimitResponse(rl)
 *
 *     const auth = authenticateBearer(req, 'METRICS_API_TOKEN')
 *     if (!auth.ok) return unauthorizedResponse(req, auth.reason)
 *
 *     // ... lógica del handler
 *   }
 *
 * ## Limitaciones conocidas
 * - El rate limiter es por instancia de proceso. Con scale-out en Railway,
 *   cada instancia mantiene su propio contador. Para rate limiting global
 *   se necesitaría Redis.
 * - Los contadores se resetean con cada deploy (comportamiento esperado).
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextRequest }            from 'next/server'

// ── Rate Limiter ──────────────────────────────────────────────────────────────

interface RateLimitEntry {
  count:   number
  resetAt: number  // Unix ms
}

interface RateLimitResult {
  allowed:   boolean
  remaining: number
  resetAt:   number  // Unix ms
  limit:     number
}

// Map global por proceso. Claves: IP address.
// Se limpia periódicamente en checkRateLimit() para evitar memory leaks.
const rateLimitStore = new Map<string, RateLimitEntry>()

// Limpiar entradas expiradas cada N llamadas para evitar acumulación indefinida.
let callsSinceCleanup = 0
const CLEANUP_INTERVAL = 500

function cleanupExpiredEntries(): void {
  const now = Date.now()
  for (const [key, entry] of rateLimitStore) {
    if (entry.resetAt <= now) rateLimitStore.delete(key)
  }
}

/**
 * Verifica el rate limit para una IP usando una ventana fija.
 *
 * @param ip        - Dirección IP del cliente
 * @param limit     - Máximo de requests por ventana (default: 60)
 * @param windowMs  - Duración de la ventana en ms (default: 60.000 = 1 minuto)
 */
export function checkRateLimit(
  ip:       string,
  limit     = 60,
  windowMs  = 60_000,
): RateLimitResult {
  // Limpieza periódica (amortizada — no bloquea en hot path)
  callsSinceCleanup++
  if (callsSinceCleanup >= CLEANUP_INTERVAL) {
    cleanupExpiredEntries()
    callsSinceCleanup = 0
  }

  const now = Date.now()
  const entry = rateLimitStore.get(ip)

  if (!entry || entry.resetAt <= now) {
    // Primera request en esta ventana (o ventana expirada)
    const resetAt = now + windowMs
    rateLimitStore.set(ip, { count: 1, resetAt })
    return { allowed: true, remaining: limit - 1, resetAt, limit }
  }

  entry.count++

  if (entry.count > limit) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt, limit }
  }

  return { allowed: true, remaining: limit - entry.count, resetAt: entry.resetAt, limit }
}

// ── Autenticación Bearer ──────────────────────────────────────────────────────

type AuthResult =
  | { ok: true }
  | { ok: false; reason: 'missing_header' | 'invalid_format' | 'invalid_token' | 'token_not_configured' }

/**
 * Valida el header `Authorization: Bearer <token>` contra una variable de entorno.
 *
 * Usa comparación en tiempo constante (timing-safe) para prevenir timing attacks:
 * ambos tokens se hashean a SHA-256 antes de comparar, igualando la longitud
 * independientemente del input y eliminando la ventana de ataque de timing.
 *
 * @param req     - NextRequest con los headers de la petición
 * @param envVar  - Nombre de la variable de entorno con el token esperado
 */
export function authenticateBearer(
  req:    NextRequest,
  envVar: string,
): AuthResult {
  const expectedToken = process.env[envVar]

  // Token no configurado en el entorno → error de configuración, no de auth
  if (!expectedToken) {
    return { ok: false, reason: 'token_not_configured' }
  }

  const authHeader = req.headers.get('authorization')
  if (!authHeader) {
    return { ok: false, reason: 'missing_header' }
  }

  if (!authHeader.startsWith('Bearer ')) {
    return { ok: false, reason: 'invalid_format' }
  }

  const providedToken = authHeader.slice(7).trim()
  if (!providedToken) {
    return { ok: false, reason: 'invalid_format' }
  }

  // Comparación en tiempo constante:
  // Hashear ambos tokens a SHA-256 para normalizar la longitud.
  // timingSafeEqual requiere buffers de igual tamaño.
  const expectedHash = createHash('sha256').update(expectedToken).digest()
  const providedHash = createHash('sha256').update(providedToken).digest()

  if (!timingSafeEqual(expectedHash, providedHash)) {
    return { ok: false, reason: 'invalid_token' }
  }

  return { ok: true }
}

// ── Helpers de IP ─────────────────────────────────────────────────────────────

/**
 * Extrae la IP real del cliente desde los headers de Railway/proxy.
 *
 * Railway inyecta `x-forwarded-for` con la IP original del cliente.
 * Si no está disponible (tests, local), retorna '127.0.0.1'.
 */
export function getClientIp(req: NextRequest): string {
  // x-forwarded-for puede contener múltiples IPs: "cliente, proxy1, proxy2"
  // La primera es siempre la IP original del cliente.
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()

  const realIp = req.headers.get('x-real-ip')
  if (realIp) return realIp.trim()

  return '127.0.0.1'
}

// ── Constructores de respuesta ────────────────────────────────────────────────

/**
 * Construye los headers estándar `X-RateLimit-*` para incluir en respuestas.
 * Informan al cliente de su estado actual y cuándo puede reintentar.
 */
export function buildRateLimitHeaders(rl: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit':     String(rl.limit),
    'X-RateLimit-Remaining': String(Math.max(0, rl.remaining)),
    'X-RateLimit-Reset':     String(Math.ceil(rl.resetAt / 1000)),  // Unix seconds
  }
}
