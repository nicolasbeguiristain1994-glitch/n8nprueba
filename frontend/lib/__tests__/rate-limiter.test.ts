// @vitest-environment node
/**
 * Tests de MemoryRateLimiter (implementación en memoria).
 * Cubre: isBlocked, increment, reset, expiración de ventana, prune y singleton del timer.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { MemoryRateLimiter } from '@/lib/rate-limit'

afterEach(() => {
  vi.useRealTimers()
})

describe('MemoryRateLimiter', () => {
  it('isBlocked() returns false for an unknown key', () => {
    const limiter = new MemoryRateLimiter({ maxAttempts: 3, windowMs: 60_000 })
    expect(limiter.isBlocked('unknown-key')).toBe(false)
  })

  it('isBlocked() returns false before maxAttempts is reached', () => {
    const limiter = new MemoryRateLimiter({ maxAttempts: 3, windowMs: 60_000 })
    limiter.increment('key-a')
    limiter.increment('key-a')
    expect(limiter.isBlocked('key-a')).toBe(false)
  })

  it('isBlocked() returns true after exactly maxAttempts increments', () => {
    const limiter = new MemoryRateLimiter({ maxAttempts: 3, windowMs: 60_000 })
    limiter.increment('key-b')
    limiter.increment('key-b')
    limiter.increment('key-b')
    expect(limiter.isBlocked('key-b')).toBe(true)
  })

  it('reset() clears the block so isBlocked() returns false', () => {
    const limiter = new MemoryRateLimiter({ maxAttempts: 2, windowMs: 60_000 })
    limiter.increment('key-c')
    limiter.increment('key-c')
    expect(limiter.isBlocked('key-c')).toBe(true)
    limiter.reset('key-c')
    expect(limiter.isBlocked('key-c')).toBe(false)
  })

  it('window expiry unblocks a key without explicit reset', () => {
    vi.useFakeTimers()
    const limiter = new MemoryRateLimiter({ maxAttempts: 2, windowMs: 1_000 })
    limiter.increment('key-d')
    limiter.increment('key-d')
    expect(limiter.isBlocked('key-d')).toBe(true)
    vi.advanceTimersByTime(1_001)
    expect(limiter.isBlocked('key-d')).toBe(false)
  })

  it('prune() removes expired entries', () => {
    vi.useFakeTimers()
    const limiter = new MemoryRateLimiter({ maxAttempts: 5, windowMs: 500 })
    limiter.increment('key-e')
    vi.advanceTimersByTime(600)
    limiter.prune()
    // After prune the entry is gone; a single new increment should not block
    limiter.increment('key-e')
    expect(limiter.isBlocked('key-e')).toBe(false)
  })

  it('increment restarts the window after previous window expired', () => {
    vi.useFakeTimers()
    const limiter = new MemoryRateLimiter({ maxAttempts: 2, windowMs: 1_000 })
    limiter.increment('key-f')
    vi.advanceTimersByTime(1_001)
    limiter.increment('key-f') // new window, count = 1
    expect(limiter.isBlocked('key-f')).toBe(false)
  })

  it('multiple instances do not start additional setInterval calls (singleton timer)', () => {
    // loginRateLimiter (MemoryRateLimiter, created at module load) already set the static timer.
    // Any further new MemoryRateLimiter() calls must NOT call setInterval again.
    const spy = vi.spyOn(global, 'setInterval')
    new MemoryRateLimiter({ maxAttempts: 5, windowMs: 60_000 })
    new MemoryRateLimiter({ maxAttempts: 5, windowMs: 60_000 })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('full flow: increment to block, reset, increment again without block', () => {
    const limiter = new MemoryRateLimiter({ maxAttempts: 3, windowMs: 60_000 })
    limiter.increment('key-g')
    limiter.increment('key-g')
    limiter.increment('key-g')
    expect(limiter.isBlocked('key-g')).toBe(true)
    limiter.reset('key-g')
    expect(limiter.isBlocked('key-g')).toBe(false)
    limiter.increment('key-g')
    limiter.increment('key-g')
    expect(limiter.isBlocked('key-g')).toBe(false) // 2 de 3, aún no bloqueado
  })

  it('each instance tracks keys independently', () => {
    const a = new MemoryRateLimiter({ maxAttempts: 2, windowMs: 60_000 })
    const b = new MemoryRateLimiter({ maxAttempts: 2, windowMs: 60_000 })
    a.increment('shared-key')
    a.increment('shared-key')
    expect(a.isBlocked('shared-key')).toBe(true)
    expect(b.isBlocked('shared-key')).toBe(false)
  })
})
