// Token Bucket para cumplir el límite de Coexistence: 20 mensajes/segundo por número.
// Implementado sobre Redis para que funcione en múltiples instancias de Node.js.
//
// Algoritmo: Token Bucket con ventana deslizante de 1 segundo.
// - Capacidad: 20 tokens
// - Recarga: 20 tokens por segundo
// - Si el bucket está vacío, retorna retryAfterMs

import { createClient } from 'redis'
import type { RateLimitResult } from './types'
import { RateLimitError } from './errors'

// El máximo de mensajes/s en Coexistence según docs de Meta (mayo 2026)
const COEXISTENCE_MAX_MPS = 20

interface RateLimiterOptions {
  maxPerSecond?: number
}

const SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = 1000
local max = tonumber(ARGV[2])

-- Limpiar tokens más viejos que 1 segundo
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window_ms)

local count = redis.call('ZCARD', key)

if count < max then
  redis.call('ZADD', key, now, now .. '-' .. math.random(1000000))
  redis.call('PEXPIRE', key, window_ms)
  return {1, max - count - 1, 0}
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_after = window_ms - (now - tonumber(oldest[2]))
  return {0, 0, math.max(retry_after, 50)}
end
`

let redisClient: ReturnType<typeof createClient> | null = null

function getRedis() {
  if (!redisClient) {
    redisClient = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
    redisClient.connect().catch(err => console.error('[rate-limiter] Redis connect error:', err))
  }
  return redisClient
}

export async function checkRateLimit(
  phoneNumberId: string,
  opts: RateLimiterOptions = {},
): Promise<RateLimitResult> {
  const max = opts.maxPerSecond ?? COEXISTENCE_MAX_MPS
  const key = `cloud:ratelimit:${phoneNumberId}`
  const now = Date.now()

  try {
    const redis = getRedis()
    const result = await redis.eval(SCRIPT, {
      keys:      [key],
      arguments: [String(now), String(max)],
    }) as [number, number, number]

    const [allowed, remaining, retryAfterMs] = result
    return {
      allowed:      allowed === 1,
      remaining:    remaining,
      retryAfterMs: retryAfterMs,
    }
  } catch (err) {
    // Si Redis no está disponible, permitir el paso (fail-open) con log de warning
    console.warn('[rate-limiter] Redis unavailable, allowing request:', err)
    return { allowed: true, remaining: max - 1, retryAfterMs: 0 }
  }
}

// Versión que lanza error si el rate limit fue alcanzado (para uso en middleware)
export async function enforceRateLimit(phoneNumberId: string): Promise<void> {
  const result = await checkRateLimit(phoneNumberId)
  if (!result.allowed) {
    throw new RateLimitError(result.retryAfterMs)
  }
}

// Esperar hasta que el rate limit permita el siguiente envío
export async function waitForRateLimit(phoneNumberId: string, maxWaitMs = 5000): Promise<void> {
  const result = await checkRateLimit(phoneNumberId)
  if (result.allowed) return

  if (result.retryAfterMs > maxWaitMs) {
    throw new RateLimitError(result.retryAfterMs)
  }

  await new Promise(r => setTimeout(r, result.retryAfterMs))

  // Re-intentar después de esperar
  const retry = await checkRateLimit(phoneNumberId)
  if (!retry.allowed) throw new RateLimitError(retry.retryAfterMs)
}
