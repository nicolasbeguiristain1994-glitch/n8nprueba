import { randomUUID } from 'crypto'
import { checkEligibility } from './prioritization-rules'
import { computeScore } from './scoring'
import { REACTIVATION_SEGMENT_RULES } from './config'
import { UserPrioritizationRepository } from './UserPrioritizationRepository'
import { getAllTiers } from '@/lib/segmentation-config-service'
import type { SegmentationTier } from '@/lib/segmentation-config-service'
import type { ScoringConfig } from './scoring'
import type { EligibilityConfig } from './prioritization-rules'
import type { ValueTier } from './config'
import {
  logRecomputeStart,
  logRecomputeBatch,
  logRecomputeEnd,
  logRecomputeError,
} from './logger'
import type {
  ContactMetricsRow,
  ContactPriorityScore,
  PaginatedResult,
  PriorityFilters,
  PrioritizedContact,
  RecomputeResult,
} from './types'

const BATCH_SIZE            = 500

// ── Configuración en runtime desde segmentation_tiers ────────────────────────

interface TierRuntimeConfigs {
  scoring:     ScoringConfig
  eligibility: EligibilityConfig
}

function buildTierRuntimeConfigs(tiers: SegmentationTier[]): TierRuntimeConfigs {
  const valueScores       = {} as Record<ValueTier, number>
  const inactivityWindows = {} as Record<ValueTier, { minDays: number; maxDays: number }>
  const recontactCooldown = {} as Record<ValueTier, number>
  const depositAmountTiers: Array<{ minAmount: number; tier: ValueTier }> = []

  for (const t of tiers) {
    valueScores[t.tier]       = t.value_score
    inactivityWindows[t.tier] = { minDays: t.min_days_inactive, maxDays: t.max_days_inactive }
    recontactCooldown[t.tier] = t.recontact_cooldown_days
    depositAmountTiers.push({ minAmount: t.deposit_threshold_min, tier: t.tier })
  }

  // resolveValueTier itera en orden y retorna el primer match → orden descendente
  depositAmountTiers.sort((a, b) => b.minAmount - a.minAmount)

  return {
    scoring: {
      valueScores,
      inactivityWindows,
      depositAmountTiers,
      reactivationSegmentRules: REACTIVATION_SEGMENT_RULES,
    },
    eligibility: {
      inactivityWindows,
      recontactCooldownDays: recontactCooldown,
      depositAmountTiers,
    },
  }
}
const INSTANCE_ID           = process.env.HOSTNAME ?? `pid-${process.pid}`
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000   // renovar TTL cada 5 minutos

export class UserPrioritizationService {
  constructor(
    private readonly repo: UserPrioritizationRepository = new UserPrioritizationRepository(),
  ) {}

  /**
   * Recomputa scores de todos los contactos.
   *
   * Idempotente: múltiples ejecuciones producen el mismo resultado.
   * Multi-instancia: locking DB (system_jobs) con ownership via lock_token.
   * Heartbeat: renueva el TTL del lock cada heartbeatIntervalMs para corridas largas.
   * Consistencia: cada batch se escribe con el mismo run_id (lockToken);
   *   en el release exitoso se registra last_complete_run_id para que el endpoint
   *   solo muestre datos de la última corrida completa.
   * Observabilidad: logs estructurados JSON por evento + historial en recompute_runs.
   */
  async recomputeAll(
    options: { batchSize?: number; heartbeatIntervalMs?: number } = {},
  ): Promise<RecomputeResult> {
    const lockToken = randomUUID()
    const acquired  = await this.repo.acquireRecomputeLock(INSTANCE_ID, lockToken)
    if (!acquired) {
      throw new RecomputeAlreadyRunningError()
    }

    const batchSize           = options.batchSize           ?? BATCH_SIZE
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    const startedAt           = new Date()
    const start               = startedAt.getTime()

    // Cargar config de tiers UNA vez para todo el batch (Redis cache → rápido).
    // Si falla, buildTierRuntimeConfigs recibe [] y scoreContact usa defaults hardcoded.
    const tierCfg = await getAllTiers().then(buildTierRuntimeConfigs).catch(() => undefined)

    let lastId: string | undefined
    let batchNum              = 0
    let processed             = 0
    let eligible              = 0
    let skipped               = 0

    logRecomputeStart({ run_id: lockToken, instance_id: INSTANCE_ID, batch_size: batchSize })

    // setInterval garantiza renovación incluso durante operaciones DB lentas dentro de un batch.
    let heartbeatRevoked = false
    const heartbeatTimer = setInterval(() => {
      this.repo.renewRecomputeLock(lockToken).then(renewed => {
        if (!renewed) {
          heartbeatRevoked = true
          clearInterval(heartbeatTimer)
        }
      }).catch(() => {
        // Fallo transitorio de red — el TTL de 30 min da margen suficiente.
      })
    }, heartbeatIntervalMs)

    try {
      while (true) {
        const contacts = await this.repo.fetchContactMetrics(batchSize, lastId)
        if (heartbeatRevoked) throw new LockRevokedError()
        if (contacts.length === 0) break

        const contactIds      = contacts.map(c => c.contactId)
        const lastMessagedMap = await this.repo.getLastMessagedDaysMap(contactIds)
        if (heartbeatRevoked) throw new LockRevokedError()

        const scores = contacts.map(contact =>
          this.scoreContact(contact, lastMessagedMap.get(contact.contactId) ?? null, tierCfg),
        )

        await this.repo.upsertScores(scores, lockToken)
        if (heartbeatRevoked) throw new LockRevokedError()

        for (const s of scores) {
          if (s.isEligible) eligible++
          else skipped++
        }

        processed += contacts.length
        batchNum++
        lastId = contacts[contacts.length - 1].contactId

        logRecomputeBatch({
          run_id:          lockToken,
          batch_num:       batchNum,
          batch_size:      contacts.length,
          total_processed: processed,
        })

        if (contacts.length < batchSize) break
      }

      clearInterval(heartbeatTimer)

      const durationMs = Date.now() - start
      const result     = { processed, eligible, skipped, durationMs }

      // Release BEFORE logging success — si falla o devuelve false (0 rows),
      // el catch emite el único logRecomputeEnd. Garantiza un solo evento por run_id.
      const released = await this.repo.releaseRecomputeLock(
        lockToken,
        result as unknown as Record<string, unknown>,
        true,
      )
      if (!released) throw new LockReleaseOwnershipError()

      logRecomputeEnd({ run_id: lockToken, status: 'success', processed, eligible, skipped, duration_ms: durationMs })

      this.repo.insertRecomputeRun({
        runId:             lockToken,
        startedAt,
        finishedAt:        new Date(),
        status:            'success',
        contactsProcessed: processed,
        contactsUpdated:   eligible,
        durationMs,
        instanceId:        INSTANCE_ID,
      }).catch(err => logRecomputeError({ run_id: lockToken, status: 'failed', error: `insertRecomputeRun failed: ${String(err)}` }))

      return result
    } catch (err) {
      clearInterval(heartbeatTimer)

      const status = (err instanceof LockRevokedError || err instanceof LockReleaseOwnershipError)
        ? 'revoked'
        : 'failed'
      const durationMs = Date.now() - start

      logRecomputeEnd({ run_id: lockToken, status, processed, eligible, skipped, duration_ms: durationMs })
      logRecomputeError({ run_id: lockToken, status, error: String(err) })

      // LockReleaseOwnershipError ya intentó el release (devolvió false) —
      // no reintentar con success=false porque el token ya no es nuestro.
      if (!(err instanceof LockReleaseOwnershipError)) {
        await this.repo.releaseRecomputeLock(lockToken, { error: String(err) }, false)
          .catch(releaseErr => logRecomputeError({ run_id: lockToken, status: 'failed', error: `releaseRecomputeLock failed: ${String(releaseErr)}` }))
      }

      this.repo.insertRecomputeRun({
        runId:             lockToken,
        startedAt,
        finishedAt:        new Date(),
        status,
        contactsProcessed: processed,
        contactsUpdated:   eligible,
        durationMs,
        errorMessage:      String(err),
        instanceId:        INSTANCE_ID,
      }).catch(() => undefined)

      throw err
    }
  }

  /**
   * Recomputa el score de un único contacto.
   * Asocia el score al último run completo para que aparezca en las queries del operador.
   * No requiere lock — es idempotente y de bajo impacto.
   */
  async recomputeForContact(contactId: string): Promise<ContactPriorityScore> {
    const contact = await this.repo.fetchContactById(contactId)
    if (!contact) throw new Error(`Contact not found: ${contactId}`)

    const [lastMessagedMap, lastRunId, tierCfg] = await Promise.all([
      this.repo.getLastMessagedDaysMap([contactId]),
      this.repo.getLastCompleteRunId(),
      getAllTiers().then(buildTierRuntimeConfigs).catch(() => undefined),
    ])

    const score = this.scoreContact(contact, lastMessagedMap.get(contactId) ?? null, tierCfg)
    await this.repo.upsertScores([score], lastRunId ?? undefined)
    return score as ContactPriorityScore
  }

  /**
   * Listado paginado para el operador.
   *
   * Por defecto filtra por el último run completo (last_complete_run_id).
   * Si no hay ningún run completo (primer deploy), devuelve todos los elegibles.
   * includePreviousRuns=true desactiva el filtro para debugging.
   */
  async getPrioritizedContacts(
    filters: PriorityFilters,
  ): Promise<PaginatedResult<PrioritizedContact>> {
    if (filters.includePreviousRuns) {
      return this.repo.getPrioritizedContacts(filters)
    }

    const lastRunId = await this.repo.getLastCompleteRunId()
    if (lastRunId) {
      return this.repo.getPrioritizedContacts({ ...filters, runId: lastRunId })
    }

    return this.repo.getPrioritizedContacts(filters)
  }

  async markBroadcasted(contactId: string, userName: string): Promise<boolean> {
    return this.repo.markBroadcasted(contactId, userName)
  }

  async unmarkBroadcasted(contactId: string): Promise<boolean> {
    return this.repo.unmarkBroadcasted(contactId)
  }

  // ── Lógica de scoring por contacto ───────────────────────────────────────────

  private scoreContact(
    contact:             ContactMetricsRow,
    daysSinceLastMessage: number | null,
    tierCfg?:            TierRuntimeConfigs,
  ): Omit<ContactPriorityScore, 'id' | 'runId'> {
    const daysInactive = contact.lastDepositAt
      ? daysBetween(contact.lastDepositAt, new Date())
      : null

    const { eligible, skipReasons, valueTier } = checkEligibility({
      status:              contact.status,
      doNotContact:        contact.doNotContact,
      optInMarketing:      contact.optInMarketing,
      deletedAt:           contact.deletedAt,
      lastDepositAt:       contact.lastDepositAt,
      segment:             contact.segment,
      totalDepositAmount:  contact.totalDepositAmount,
      daysInactive,
      daysSinceLastMessage,
    }, tierCfg?.eligibility)

    const breakdown = eligible && daysInactive !== null
      ? computeScore({
          daysInactive,
          segment:            contact.segment,
          totalDepositAmount: contact.totalDepositAmount,
        }, tierCfg?.scoring)
      : null

    return {
      contactId:           contact.contactId,
      priorityScore:       breakdown?.total           ?? 0,
      reactivationSegment: breakdown?.reactivationSegment ?? null,
      valueTier:           breakdown?.valueTier        ?? valueTier,
      valueScore:          breakdown?.valueScore       ?? 0,
      urgencyScore:        breakdown?.urgencyScore     ?? 0,
      daysInactive,
      depositSegment:      contact.segment,
      totalDepositAmount:  contact.totalDepositAmount,
      isEligible:          eligible,
      skipReasons,
      computedAt:          new Date(),
    }
  }
}

// ── Errores tipados para manejo en route handlers ─────────────────────────────

export class RecomputeAlreadyRunningError extends Error {
  constructor() {
    super('Un recompute ya está en curso. Espere a que termine o expire el TTL (30 min).')
    this.name = 'RecomputeAlreadyRunningError'
  }
}

export class LockRevokedError extends Error {
  constructor() {
    super('El lock fue revocado por otra instancia o expiró durante el recompute.')
    this.name = 'LockRevokedError'
  }
}

export class LockReleaseOwnershipError extends Error {
  constructor() {
    super('El lock ya no pertenece a esta instancia al momento del release — otra instancia lo re-adquirió.')
    this.name = 'LockReleaseOwnershipError'
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000)
}
