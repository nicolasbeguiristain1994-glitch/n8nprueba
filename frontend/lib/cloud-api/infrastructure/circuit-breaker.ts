// Circuit Breaker para llamadas a Meta Graph API.
//
// Estados: CLOSED → OPEN → HALF_OPEN → CLOSED
//
// CLOSED: operación normal. Si hay N fallos consecutivos → OPEN.
// OPEN:   rechaza inmediatamente. Después de cooldown → HALF_OPEN.
// HALF_OPEN: permite 1 llamada de prueba. Si OK → CLOSED; si falla → OPEN.
//
// Granularidad: un breaker por phoneNumberId para aislar problemas.

import { createLogger } from './logger'

const log = createLogger({ correlationId: 'system', operation: 'circuit_breaker' })

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

interface BreakerConfig {
  failureThreshold:  number  // fallos consecutivos para abrir (default 5)
  successThreshold:  number  // éxitos para cerrar desde HALF_OPEN (default 2)
  cooldownMs:        number  // tiempo en OPEN antes de HALF_OPEN (default 30s)
  timeoutMs:         number  // timeout de la llamada (default 15s)
}

interface BreakerRecord {
  state:           BreakerState
  failureCount:    number
  successCount:    number
  lastFailureAt:   number
  nextAttemptAt:   number
}

const DEFAULT_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  cooldownMs:       30_000,
  timeoutMs:        15_000,
}

// Instancias en memoria (process-level, suficiente para Next.js single-process)
const breakers = new Map<string, BreakerRecord>()

function getBreaker(key: string): BreakerRecord {
  if (!breakers.has(key)) {
    breakers.set(key, {
      state:         'CLOSED',
      failureCount:  0,
      successCount:  0,
      lastFailureAt: 0,
      nextAttemptAt: 0,
    })
  }
  return breakers.get(key)!
}

function transitionTo(record: BreakerRecord, state: BreakerState, cfg: BreakerConfig): void {
  record.state = state
  if (state === 'OPEN') {
    record.nextAttemptAt = Date.now() + cfg.cooldownMs
    record.successCount  = 0
  }
  if (state === 'CLOSED') {
    record.failureCount = 0
    record.successCount = 0
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(public readonly key: string, public readonly nextAttemptAt: number) {
    super(`Circuit breaker OPEN for ${key}. Next attempt at ${new Date(nextAttemptAt).toISOString()}`)
    this.name = 'CircuitBreakerOpenError'
  }
}

export async function withCircuitBreaker<T>(
  key:      string,
  fn:       () => Promise<T>,
  cfg:      Partial<BreakerConfig> = {},
): Promise<T> {
  const config = { ...DEFAULT_CONFIG, ...cfg }
  const record = getBreaker(key)
  const now    = Date.now()

  if (record.state === 'OPEN') {
    if (now < record.nextAttemptAt) {
      throw new CircuitBreakerOpenError(key, record.nextAttemptAt)
    }
    // Cooldown expirado → intentar half-open
    transitionTo(record, 'HALF_OPEN', config)
  }

  try {
    const result = await fn()

    // Éxito
    if (record.state === 'HALF_OPEN') {
      record.successCount++
      if (record.successCount >= config.successThreshold) {
        transitionTo(record, 'CLOSED', config)
      }
    } else {
      record.failureCount = 0
    }

    return result
  } catch (err) {
    record.failureCount++
    record.lastFailureAt = Date.now()

    if (record.state === 'HALF_OPEN' || record.failureCount >= config.failureThreshold) {
      transitionTo(record, 'OPEN', config)
      log.logError('breaker OPENED', undefined, { key, failureCount: record.failureCount })
    }

    throw err
  }
}

export function getBreakerStatus(key: string): { state: BreakerState; failureCount: number; nextAttemptAt: number } {
  const record = getBreaker(key)
  return { state: record.state, failureCount: record.failureCount, nextAttemptAt: record.nextAttemptAt }
}

export function resetBreaker(key: string): void {
  breakers.delete(key)
}

export function getAllBreakerStatuses(): Record<string, ReturnType<typeof getBreakerStatus>> {
  return Object.fromEntries(
    Array.from(breakers.entries()).map(([k, _]) => [k, getBreakerStatus(k)])
  )
}
