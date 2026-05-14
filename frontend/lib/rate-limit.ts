/**
 * Rate limiting — interfaz + implementaciones intercambiables.
 *
 * Arquitectura:
 *   RateLimiterAdapter  — interfaz pública (isBlocked / increment / reset)
 *   MemoryRateLimiter   — implementación en memoria (actual, single-instance)
 *   RedisRateLimiter    — implementación Redis (distribuida, multi-instance)
 *
 * El singleton `loginRateLimiter` se elige automáticamente según REDIS_URL:
 *   - REDIS_URL definida  → RedisRateLimiter  (producción multi-instancia)
 *   - REDIS_URL ausente   → MemoryRateLimiter (dev local / single-instance)
 *
 * El código consumidor (login route, tests) no necesita cambiar — usa siempre
 * `loginRateLimiter` con la misma interfaz.
 */

// ── Interfaz pública ──────────────────────────────────────────────────────────

export interface RateLimiterAdapter {
  /** Returns true if `key` has exceeded the limit and must be blocked. */
  isBlocked(key: string): Promise<boolean> | boolean
  /** Record one failed attempt for `key`. */
  increment(key: string): Promise<void> | void
  /** Clear the counter for `key` (e.g. after a successful attempt). */
  reset(key: string): Promise<void> | void
}

export type RateLimiterConfig = {
  /** Maximum failed attempts within the window before blocking. */
  maxAttempts: number
  /** Length of the sliding window in milliseconds. */
  windowMs: number
}

// ── MemoryRateLimiter ─────────────────────────────────────────────────────────
//
// State lives in the Node.js process heap.
//
// Pros:  zero dependencies, zero latency, works offline
// Cons:  resets on server restart; not shared across instances
// When to use: single-instance deployments, local development

type Entry = { count: number; resetAt: number }

export class MemoryRateLimiter implements RateLimiterAdapter {
  // Shared prune interval — one timer per process regardless of instance count
  private static readonly instances = new Set<MemoryRateLimiter>()
  private static pruneTimer: ReturnType<typeof setInterval> | null = null

  private static startPruneInterval(): void {
    if (MemoryRateLimiter.pruneTimer !== null) return
    MemoryRateLimiter.pruneTimer = setInterval(() => {
      for (const limiter of MemoryRateLimiter.instances) limiter.prune()
    }, 10 * 60 * 1000)
  }

  private readonly store = new Map<string, Entry>()
  private readonly maxAttempts: number
  private readonly windowMs: number

  constructor({ maxAttempts, windowMs }: RateLimiterConfig) {
    this.maxAttempts = maxAttempts
    this.windowMs    = windowMs
    MemoryRateLimiter.instances.add(this)
    MemoryRateLimiter.startPruneInterval()
  }

  isBlocked(key: string): boolean {
    const entry = this.store.get(key)
    if (!entry || Date.now() > entry.resetAt) return false
    return entry.count >= this.maxAttempts
  }

  increment(key: string): void {
    const now   = Date.now()
    const entry = this.store.get(key)
    if (!entry || now > entry.resetAt) {
      this.store.set(key, { count: 1, resetAt: now + this.windowMs })
    } else {
      entry.count++
    }
  }

  reset(key: string): void {
    this.store.delete(key)
  }

  prune(): void {
    const now = Date.now()
    for (const [key, entry] of this.store) {
      if (now > entry.resetAt) this.store.delete(key)
    }
  }
}

// ── RedisRateLimiter ──────────────────────────────────────────────────────────
//
// State lives in Redis — shared across all Node.js instances.
//
// Pros:  survives server restarts; works with horizontal scaling
// Cons:  requires Redis; adds ~1ms latency per check (local Redis)
// When to use: multi-instance / containerised production deployments
//
// Implementation: counter key with INCR + TTL set on first write.
// Key format: `rl:<prefix>:<key>`  (e.g. `rl:login:203.0.113.42`)
//
// Failure mode: if Redis is unreachable, all checks return false (fail-open).
// This is a deliberate trade-off: login availability > rate limit enforcement
// during a Redis outage. Change failOpen to true/false to match your policy.

import { createClient } from 'redis'
import { appLog } from '@/lib/security-log'

type RedisClient = ReturnType<typeof createClient>

export class RedisRateLimiter implements RateLimiterAdapter {
  private client: RedisClient | null = null
  private readonly maxAttempts: number
  private readonly windowSecs: number
  private readonly keyPrefix: string

  constructor({ maxAttempts, windowMs }: RateLimiterConfig, keyPrefix = 'rl') {
    this.maxAttempts = maxAttempts
    this.windowSecs  = Math.ceil(windowMs / 1000)
    this.keyPrefix   = keyPrefix
  }

  private getClient(): RedisClient {
    if (!this.client) {
      this.client = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
      this.client.connect().catch(err =>
        appLog('ERROR', 'redis rate-limiter connect failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      )
    }
    return this.client
  }

  private key(k: string): string {
    return `${this.keyPrefix}:${k}`
  }

  async isBlocked(key: string): Promise<boolean> {
    try {
      const client = this.getClient()
      const count  = await client.get(this.key(key))
      return count !== null && parseInt(count, 10) >= this.maxAttempts
    } catch {
      return false // fail-open: prefer login availability over enforcement on Redis error
    }
  }

  async increment(key: string): Promise<void> {
    try {
      const client = this.getClient()
      const rkey   = this.key(key)
      // Pipeline sends INCR + EXPIRE in a single roundtrip — atomic from
      // Redis's perspective. Without pipeline, a crash between the two commands
      // leaves a key with no TTL that blocks the IP permanently.
      // Side effect: EXPIRE resets on every increment (sliding window).
      // An attacker who keeps trying stays blocked 15 min after their last attempt.
      const pipeline = client.multi()
      pipeline.incr(rkey)
      pipeline.expire(rkey, this.windowSecs)
      await pipeline.exec()
    } catch {
      // fail-open — do not block login on Redis error
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.getClient().del(this.key(key))
    } catch {
      // non-fatal
    }
  }
}

// ── Factory & singleton ───────────────────────────────────────────────────────

const LOGIN_CONFIG: RateLimiterConfig = {
  maxAttempts: 10,
  windowMs:    15 * 60 * 1000, // 15 minutes
}

function createLoginRateLimiter(): RateLimiterAdapter {
  if (process.env.REDIS_URL) {
    return new RedisRateLimiter(LOGIN_CONFIG, 'rl:login')
  }
  return new MemoryRateLimiter(LOGIN_CONFIG)
}

/**
 * Login rate limiter: 10 failed attempts per IP per 15 minutes.
 * Backend chosen automatically: Redis if REDIS_URL is set, memory otherwise.
 * Only incremented on failure; reset on success.
 */
export const loginRateLimiter = createLoginRateLimiter()
