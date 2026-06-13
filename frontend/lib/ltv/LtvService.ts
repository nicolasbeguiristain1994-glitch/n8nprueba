import { randomUUID } from 'crypto'
import { LtvRepository } from './LtvRepository'
import type { LtvRecomputeResult } from './LtvRepository'

const INSTANCE_ID           = process.env.HOSTNAME ?? `pid-${process.pid}`
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000

export class LtvService {
  constructor(
    private readonly repo: LtvRepository = new LtvRepository(),
  ) {}

  /**
   * Ejecuta refresh_player_ltv() + REFRESH MATERIALIZED VIEW CONCURRENTLY.
   *
   * Protegido por el lock 'ltv_recompute' en system_jobs (mismo mecanismo que
   * prioritization_recompute). Solo una instancia puede ejecutarlo a la vez.
   * Heartbeat cada 5 min para jobs de larga duración.
   */
  async recomputeAll(): Promise<LtvRecomputeResult & { triggeredBy: string }> {
    const lockToken = randomUUID()
    const acquired  = await this.repo.acquireLock(INSTANCE_ID, lockToken)
    if (!acquired) {
      throw new LtvRecomputeAlreadyRunningError()
    }

    const start = Date.now()

    let heartbeatRevoked = false
    const heartbeatTimer = setInterval(() => {
      this.repo.renewLock(lockToken).then(renewed => {
        if (!renewed) {
          heartbeatRevoked = true
          clearInterval(heartbeatTimer)
        }
      }).catch(() => undefined)
    }, HEARTBEAT_INTERVAL_MS)

    try {
      if (heartbeatRevoked) throw new LtvLockRevokedError()

      const result = await this.repo.refreshAll()

      clearInterval(heartbeatTimer)

      const released = await this.repo.releaseLock(
        lockToken,
        result as unknown as Record<string, unknown>,
        true,
      )
      if (!released) throw new LtvLockReleaseOwnershipError()

      return { ...result, triggeredBy: INSTANCE_ID }
    } catch (err) {
      clearInterval(heartbeatTimer)

      if (!(err instanceof LtvLockReleaseOwnershipError)) {
        await this.repo.releaseLock(lockToken, { error: String(err) }, false)
          .catch(() => undefined)
      }

      throw err
    }
  }

  async getPlayers(opts: Parameters<LtvRepository['getPlayers']>[0]) {
    return this.repo.getPlayers(opts)
  }

  async getDistribution() {
    return this.repo.getDistribution()
  }

  async getLastSuccessAt() {
    return this.repo.getLastSuccessAt()
  }
}

// ── Errores tipados ───────────────────────────────────────────────────────────

export class LtvRecomputeAlreadyRunningError extends Error {
  constructor() {
    super('Un recálculo de LTV ya está en curso. Esperá a que termine o expire el TTL (30 min).')
    this.name = 'LtvRecomputeAlreadyRunningError'
  }
}

export class LtvLockRevokedError extends Error {
  constructor() {
    super('El lock de LTV fue revocado por otra instancia durante el recálculo.')
    this.name = 'LtvLockRevokedError'
  }
}

export class LtvLockReleaseOwnershipError extends Error {
  constructor() {
    super('El lock de LTV ya no pertenece a esta instancia al momento del release.')
    this.name = 'LtvLockReleaseOwnershipError'
  }
}
