// @vitest-environment node
/**
 * Tests de integración del UserPrioritizationService.
 *
 * Estrategia: mockeamos el repositorio completo para testear la orquestación
 * del servicio de forma rápida y determinista.
 * La cobertura de DB real (UPSERT, locking, queries SQL) va en una suite de
 * integración separada que corre contra un schema de test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  UserPrioritizationService,
  RecomputeAlreadyRunningError,
  LockRevokedError,
  LockReleaseOwnershipError,
} from '@/lib/user-prioritization/UserPrioritizationService'
import { UserPrioritizationRepository } from '@/lib/user-prioritization/UserPrioritizationRepository'
import type { ContactMetricsRow, ContactPriorityScore } from '@/lib/user-prioritization/types'

vi.mock('@/lib/user-prioritization/UserPrioritizationRepository')

const MockRepo = vi.mocked(UserPrioritizationRepository)

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeContact(overrides: Partial<ContactMetricsRow> = {}): ContactMetricsRow {
  return {
    contactId:          'c1',
    phoneNumber:        '+5491100000001',
    firstName:          'Ana',
    lastName:           'García',
    status:             'active',
    segment:            'alto',
    lastDepositAt:      daysAgo(15),
    totalDeposits:      10,
    totalDepositAmount: null,
    lastDepositAmount:  null,
    doNotContact:       false,
    optInMarketing:     true,
    deletedAt:          null,
    ...overrides,
  }
}

function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

// ── Suite principal ───────────────────────────────────────────────────────────

describe('UserPrioritizationService.recomputeAll', () => {
  let service: UserPrioritizationService
  let repo: UserPrioritizationRepository

  beforeEach(() => {
    MockRepo.mockClear()
    service = new UserPrioritizationService()
    repo    = MockRepo.mock.instances[0]

    // Lock siempre disponible por defecto en tests
    vi.mocked(repo.acquireRecomputeLock).mockResolvedValue(true)
    vi.mocked(repo.releaseRecomputeLock).mockResolvedValue(true)
    vi.mocked(repo.renewRecomputeLock).mockResolvedValue(true)
    vi.mocked(repo.upsertScores).mockResolvedValue()
    vi.mocked(repo.insertRecomputeRun).mockResolvedValue()
    vi.mocked(repo.getLastMessagedDaysMap).mockResolvedValue(new Map())
    vi.mocked(repo.getLastCompleteRunId).mockResolvedValue(null)
  })

  // ── Locking ────────────────────────────────────────────────────────────────

  it('lanza RecomputeAlreadyRunningError si el lock no está disponible', async () => {
    vi.mocked(repo.acquireRecomputeLock).mockResolvedValue(false)

    await expect(service.recomputeAll()).rejects.toThrow(RecomputeAlreadyRunningError)
    expect(repo.upsertScores).not.toHaveBeenCalled()
    expect(repo.releaseRecomputeLock).not.toHaveBeenCalled()
  })

  it('libera el lock con success=false si el procesamiento falla', async () => {
    vi.mocked(repo.fetchContactMetrics).mockRejectedValue(new Error('DB timeout'))

    await expect(service.recomputeAll()).rejects.toThrow('DB timeout')
    expect(repo.releaseRecomputeLock).toHaveBeenCalledOnce()
    expect(repo.releaseRecomputeLock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: expect.stringContaining('DB timeout') }),
      false,
    )
  })

  it('libera el lock con success=true al completar sin errores', async () => {
    vi.mocked(repo.fetchContactMetrics).mockResolvedValue([])

    const result = await service.recomputeAll()

    expect(result.processed).toBe(0)
    expect(repo.releaseRecomputeLock).toHaveBeenCalledOnce()
    expect(repo.releaseRecomputeLock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ processed: 0, eligible: 0, skipped: 0 }),
      true,
    )
  })

  it('el lock_token pasado a acquire es el mismo que se usa en release', async () => {
    vi.mocked(repo.fetchContactMetrics).mockResolvedValue([])

    await service.recomputeAll()

    const acquireCall = vi.mocked(repo.acquireRecomputeLock).mock.calls[0]
    const releaseCall = vi.mocked(repo.releaseRecomputeLock).mock.calls[0]

    const tokenInAcquire = acquireCall[1]
    const tokenInRelease = releaseCall[0]

    expect(tokenInAcquire).toBe(tokenInRelease)
  })

  // ── Casos vacíos ───────────────────────────────────────────────────────────

  it('retorna ceros con durationMs ≥ 0 si no hay contactos', async () => {
    vi.mocked(repo.fetchContactMetrics).mockResolvedValue([])

    const result = await service.recomputeAll()

    expect(result.processed).toBe(0)
    expect(result.eligible).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  // ── Escenarios de negocio — clasificación y segmentos ─────────────────────

  it('VIP recién inactivo (7 días) → elegible, URGENTE, score máximo', async () => {
    const contact = makeContact({
      segment:       'vip',
      lastDepositAt: daysAgo(7),
    })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    const score = capturedScores[0]
    expect(score.isEligible).toBe(true)
    expect(score.reactivationSegment).toBe('REACTIVACION_URGENTE')
    expect(score.valueTier).toBe('vip')
    expect(score.priorityScore).toBe(100)
    expect(score.skipReasons).toEqual([])
  })

  it('VIP inactivo 60 días → elegible, PRIORITARIA', async () => {
    const contact = makeContact({ segment: 'vip', lastDepositAt: daysAgo(60) })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    const score = capturedScores[0]
    expect(score.isEligible).toBe(true)
    expect(score.reactivationSegment).toBe('REACTIVACION_PRIORITARIA')
    expect(score.valueTier).toBe('vip')
    expect(score.priorityScore).toBeLessThan(100)
  })

  it('VIP inactivo 100 días → elegible, ESTANDAR', async () => {
    const contact = makeContact({ segment: 'vip', lastDepositAt: daysAgo(100) })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].reactivationSegment).toBe('REACTIVACION_ESTANDAR')
    expect(capturedScores[0].isEligible).toBe(true)
  })

  it('VIP inactivo 130 días → elegible, FRIA_ALTO_VALOR (ventana extendida a 180d)', async () => {
    // Decisión 2: VIP/ALTO de alto valor siguen en lista hasta 6/5 meses.
    const contact = makeContact({ segment: 'vip', lastDepositAt: daysAgo(130) })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].isEligible).toBe(true)
    expect(capturedScores[0].reactivationSegment).toBe('REACTIVACION_FRIA_ALTO_VALOR')
    expect(capturedScores[0].skipReasons).toEqual([])
    expect(capturedScores[0].priorityScore).toBeGreaterThan(0) // valueScore + urgencyScore pequeño
  })

  it('VIP inactivo 185 días → NO elegible (too_cold, superó ventana de 180d)', async () => {
    const contact = makeContact({ segment: 'vip', lastDepositAt: daysAgo(185) })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].isEligible).toBe(false)
    expect(capturedScores[0].skipReasons).toContain('too_cold')
    expect(capturedScores[0].reactivationSegment).toBeNull()
    expect(capturedScores[0].priorityScore).toBe(0)
  })

  it('VIP al final de ventana (180 días) → elegible con score=60, último segmento', async () => {
    // Decisión 1: urgencyScore=0 NO excluye al contacto — es "última oportunidad".
    // Score = 60 (valor) + 0 (urgencia) = 60, que supera a BAJO inicio de ventana (50).
    const contact = makeContact({ segment: 'vip', lastDepositAt: daysAgo(180) })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].isEligible).toBe(true)
    expect(capturedScores[0].urgencyScore).toBe(0)
    expect(capturedScores[0].valueScore).toBe(60)
    expect(capturedScores[0].priorityScore).toBe(60)
    expect(capturedScores[0].reactivationSegment).toBe('REACTIVACION_FRIA_ALTO_VALOR')
  })

  it('ALTO inactivo 140 días → elegible, FRIA_ALTO_VALOR', async () => {
    const contact = makeContact({ segment: 'alto', lastDepositAt: daysAgo(140) })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].isEligible).toBe(true)
    expect(capturedScores[0].reactivationSegment).toBe('REACTIVACION_FRIA_ALTO_VALOR')
  })

  it('ALTO inactivo 155 días → NO elegible (ventana ALTO termina en 150d)', async () => {
    const contact = makeContact({ segment: 'alto', lastDepositAt: daysAgo(155) })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].isEligible).toBe(false)
    expect(capturedScores[0].skipReasons).toContain('too_cold')
  })

  it('MEDIO inactivo 10 días → NO elegible (still_active para su tier, mínimo 14d)', async () => {
    const contact = makeContact({ segment: 'medio', lastDepositAt: daysAgo(10) })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].isEligible).toBe(false)
    expect(capturedScores[0].skipReasons).toContain('still_active')
  })

  it('BAJO inactivo 37 días → elegible, FRIA', async () => {
    const contact = makeContact({ segment: 'bajo', lastDepositAt: daysAgo(37) })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].isEligible).toBe(true)
    expect(capturedScores[0].reactivationSegment).toBe('REACTIVACION_FRIA')
    expect(capturedScores[0].valueTier).toBe('bajo')
  })

  it('BAJO inactivo 20 días → NO elegible (fuera de su ventana 30–45)', async () => {
    const contact = makeContact({ segment: 'bajo', lastDepositAt: daysAgo(20) })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].isEligible).toBe(false)
    expect(capturedScores[0].skipReasons).toContain('still_active')
  })

  // ── Cooldown por tier ─────────────────────────────────────────────────────

  it('VIP mensajeado hace 2 días → no elegible (cooldown VIP = 3 días)', async () => {
    const contact = makeContact({ segment: 'vip', lastDepositAt: daysAgo(15) })
    vi.mocked(repo.getLastMessagedDaysMap).mockResolvedValue(new Map([['c1', 2]]))

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].skipReasons).toContain('recently_messaged')
  })

  it('VIP mensajeado hace 4 días → elegible (cooldown VIP = 3 días)', async () => {
    const contact = makeContact({ segment: 'vip', lastDepositAt: daysAgo(15) })
    vi.mocked(repo.getLastMessagedDaysMap).mockResolvedValue(new Map([['c1', 4]]))

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].isEligible).toBe(true)
    expect(capturedScores[0].skipReasons).not.toContain('recently_messaged')
  })

  it('BAJO mensajeado hace 10 días → no elegible (cooldown BAJO = 14 días)', async () => {
    const contact = makeContact({ segment: 'bajo', lastDepositAt: daysAgo(35) })
    vi.mocked(repo.getLastMessagedDaysMap).mockResolvedValue(new Map([['c1', 10]]))

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].skipReasons).toContain('recently_messaged')
  })

  // ── Exclusiones generales ─────────────────────────────────────────────────

  it('do_not_contact = true → no elegible independiente del tier', async () => {
    const contact = makeContact({ segment: 'vip', doNotContact: true, lastDepositAt: daysAgo(10) })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].isEligible).toBe(false)
    expect(capturedScores[0].skipReasons).toContain('do_not_contact')
    expect(capturedScores[0].priorityScore).toBe(0)
  })

  it('status "suspended" → no elegible', async () => {
    const contact = makeContact({ status: 'suspended', lastDepositAt: daysAgo(15) })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].isEligible).toBe(false)
    expect(capturedScores[0].skipReasons).toContain('status_invalid')
  })

  it('status "inactive" → elegible (es exactamente el perfil objetivo de reactivación)', async () => {
    const contact = makeContact({ status: 'inactive', segment: 'alto', lastDepositAt: daysAgo(20) })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].isEligible).toBe(true)
    expect(capturedScores[0].skipReasons).toEqual([])
  })

  it('sin historial de depósitos → no elegible', async () => {
    const contact = makeContact({ lastDepositAt: null, totalDepositAmount: null })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    expect(capturedScores[0].skipReasons).toContain('no_deposit_history')
  })

  // ── Snapshot de métricas ──────────────────────────────────────────────────

  it('guarda el segmento y el monto como snapshot en el score', async () => {
    const contact = makeContact({
      segment:            'alto',
      lastDepositAt:      daysAgo(20),
      totalDepositAmount: 5000,
    })

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await service.recomputeAll()

    const score = capturedScores[0]
    expect(score.depositSegment).toBe('alto')
    expect(score.totalDepositAmount).toBe(5000)
    // Monto 5000 → tier 'alto' (3000-9999), mismo tier que el segment
    expect(score.valueTier).toBe('alto')
    expect(score.daysInactive).toBeGreaterThanOrEqual(19)
    expect(score.daysInactive).toBeLessThanOrEqual(21)
  })

  // ── Batch processing ──────────────────────────────────────────────────────

  it('procesa múltiples batches y acumula correctamente los totales', async () => {
    const contacts = Array.from({ length: 3 }, (_, i) =>
      makeContact({ contactId: `c${i}`, lastDepositAt: daysAgo(15 + i * 5) }),
    )

    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce(contacts.slice(0, 2))
      .mockResolvedValueOnce(contacts.slice(2))
      .mockResolvedValueOnce([])

    const result = await service.recomputeAll({ batchSize: 2 })

    expect(result.processed).toBe(3)
    expect(repo.upsertScores).toHaveBeenCalledTimes(2)
  })

  // ── upsertScores recibe el lockToken como runId ────────────────────────────

  it('pasa el lockToken como runId a upsertScores', async () => {
    const contact = makeContact({ segment: 'vip', lastDepositAt: daysAgo(15) })
    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce([contact])
      .mockResolvedValueOnce([])

    await service.recomputeAll()

    const acquireToken = vi.mocked(repo.acquireRecomputeLock).mock.calls[0][1]
    const upsertRunId  = vi.mocked(repo.upsertScores).mock.calls[0][1]

    expect(upsertRunId).toBe(acquireToken)
  })

  // ── skip_reasons con longitudes variables (ragged arrays) ──────────────────

  it('pasa skip_reasons de longitud variable a upsertScores sin errores', async () => {
    const contacts = [
      makeContact({ contactId: 'c1', segment: 'vip', lastDepositAt: daysAgo(15) }),         // eligible → []
      makeContact({ contactId: 'c2', status: 'suspended', lastDepositAt: daysAgo(15) }),    // ineligible → ['status_not_eligible']
      makeContact({ contactId: 'c3', doNotContact: true, lastDepositAt: daysAgo(15) }),     // ineligible → ['do_not_contact']
    ]
    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce(contacts)
      .mockResolvedValueOnce([])

    let capturedScores: Omit<ContactPriorityScore, 'id'>[] = []
    vi.mocked(repo.upsertScores).mockImplementation(async (s) => { capturedScores = s })

    await expect(service.recomputeAll()).resolves.not.toThrow()

    // Verifica que hay arrays de longitud 0 y > 0 (ragged)
    const skipLengths = capturedScores.map(s => s.skipReasons.length)
    expect(skipLengths).toContain(0)
    expect(skipLengths.some(l => l > 0)).toBe(true)
  })

  // ── Propagación de errores en releaseRecomputeLock ────────────────────────

  it('propaga el error si releaseRecomputeLock lanza en el path de éxito', async () => {
    vi.mocked(repo.fetchContactMetrics).mockResolvedValue([])
    vi.mocked(repo.releaseRecomputeLock).mockRejectedValue(new Error('DB connection lost'))

    await expect(service.recomputeAll()).rejects.toThrow('DB connection lost')
  })

  it('lanza LockReleaseOwnershipError si releaseRecomputeLock devuelve false (0 rows)', async () => {
    vi.mocked(repo.fetchContactMetrics).mockResolvedValue([])
    vi.mocked(repo.releaseRecomputeLock).mockResolvedValue(false)

    await expect(service.recomputeAll()).rejects.toThrow(LockReleaseOwnershipError)
  })

  it('no intenta un segundo release cuando lanza LockReleaseOwnershipError', async () => {
    vi.mocked(repo.fetchContactMetrics).mockResolvedValue([])
    vi.mocked(repo.releaseRecomputeLock).mockResolvedValue(false)

    await expect(service.recomputeAll()).rejects.toThrow(LockReleaseOwnershipError)

    // Solo una llamada — la que devolvió false. No debe reintentar con success=false.
    expect(repo.releaseRecomputeLock).toHaveBeenCalledOnce()
  })

  // ── Un solo logRecomputeEnd por run_id ────────────────────────────────────

  it('emite un solo prioritization_recompute_end cuando releaseRecomputeLock lanza', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      vi.mocked(repo.fetchContactMetrics).mockResolvedValue([])
      vi.mocked(repo.releaseRecomputeLock).mockRejectedValue(new Error('release failed'))

      await expect(service.recomputeAll()).rejects.toThrow('release failed')

      const written  = stdoutSpy.mock.calls.map(c => String(c[0])).join('')
      const endCount = (written.match(/prioritization_recompute_end/g) ?? []).length
      expect(endCount).toBe(1)
    } finally {
      stdoutSpy.mockRestore()
    }
  })

  it('emite un solo prioritization_recompute_end cuando releaseRecomputeLock devuelve false', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      vi.mocked(repo.fetchContactMetrics).mockResolvedValue([])
      vi.mocked(repo.releaseRecomputeLock).mockResolvedValue(false)

      await expect(service.recomputeAll()).rejects.toThrow(LockReleaseOwnershipError)

      const written  = stdoutSpy.mock.calls.map(c => String(c[0])).join('')
      const endCount = (written.match(/prioritization_recompute_end/g) ?? []).length
      expect(endCount).toBe(1)
    } finally {
      stdoutSpy.mockRestore()
    }
  })
})

// ── Heartbeat ─────────────────────────────────────────────────────────────────

describe('UserPrioritizationService — heartbeat', () => {
  let service: UserPrioritizationService
  let repo: UserPrioritizationRepository

  beforeEach(() => {
    MockRepo.mockClear()
    service = new UserPrioritizationService()
    repo    = MockRepo.mock.instances[0]

    vi.mocked(repo.acquireRecomputeLock).mockResolvedValue(true)
    vi.mocked(repo.releaseRecomputeLock).mockResolvedValue(true)
    vi.mocked(repo.renewRecomputeLock).mockResolvedValue(true)
    vi.mocked(repo.upsertScores).mockResolvedValue()
    vi.mocked(repo.insertRecomputeRun).mockResolvedValue()
    vi.mocked(repo.getLastMessagedDaysMap).mockResolvedValue(new Map())
    vi.mocked(repo.getLastCompleteRunId).mockResolvedValue(null)
  })

  it('no llama a renewRecomputeLock si el intervalo no se cumplió', async () => {
    vi.mocked(repo.fetchContactMetrics).mockResolvedValue([])

    await service.recomputeAll({ heartbeatIntervalMs: 999_999 })

    expect(repo.renewRecomputeLock).not.toHaveBeenCalled()
  })

  it('renueva el lock cuando el setInterval dispara durante una operación lenta', async () => {
    vi.useFakeTimers()
    try {
      // El fetch tarda 6s; el intervalo dispara a 5s → heartbeat se ejecuta antes de que resuelva el fetch
      vi.mocked(repo.fetchContactMetrics).mockImplementationOnce(
        () => new Promise(res => setTimeout(() => res([]), 6000)),
      )

      const promise = service.recomputeAll({ heartbeatIntervalMs: 5000 })
      await vi.advanceTimersByTimeAsync(6000) // interval dispara a 5000ms, fetch resuelve a 6000ms
      await promise

      expect(repo.renewRecomputeLock).toHaveBeenCalled()
      const acquireToken = vi.mocked(repo.acquireRecomputeLock).mock.calls[0][1]
      expect(repo.renewRecomputeLock).toHaveBeenCalledWith(acquireToken)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lanza LockRevokedError y libera el lock si renewRecomputeLock retorna false', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(repo.renewRecomputeLock).mockResolvedValue(false)
      vi.mocked(repo.fetchContactMetrics).mockImplementationOnce(
        () => new Promise(res => setTimeout(() => res([]), 6000)),
      )

      const promise = service.recomputeAll({ heartbeatIntervalMs: 5000 })
      void promise.catch(() => undefined) // evita "unhandled rejection" mientras corren los timers
      await vi.advanceTimersByTimeAsync(6000)
      await expect(promise).rejects.toThrow(LockRevokedError)

      expect(repo.releaseRecomputeLock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ error: expect.stringContaining('revocado') }),
        false,
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── getPrioritizedContacts — filtrado por run_id ──────────────────────────────

describe('UserPrioritizationService — getPrioritizedContacts', () => {
  let service: UserPrioritizationService
  let repo: UserPrioritizationRepository

  const emptyPage = { data: [], total: 0, page: 1, pageSize: 50, totalPages: 0 }

  beforeEach(() => {
    MockRepo.mockClear()
    service = new UserPrioritizationService()
    repo    = MockRepo.mock.instances[0]

    vi.mocked(repo.getPrioritizedContacts).mockResolvedValue(emptyPage)
    vi.mocked(repo.getLastCompleteRunId).mockResolvedValue(null)
  })

  it('pasa runId al repo cuando hay un run completo', async () => {
    vi.mocked(repo.getLastCompleteRunId).mockResolvedValue('run-abc-123')

    await service.getPrioritizedContacts({ page: 1, pageSize: 50 })

    expect(repo.getPrioritizedContacts).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-abc-123' }),
    )
  })

  it('no aplica filtro de runId si no hay corrida completa aún', async () => {
    vi.mocked(repo.getLastCompleteRunId).mockResolvedValue(null)

    await service.getPrioritizedContacts({ page: 1, pageSize: 50 })

    const call = vi.mocked(repo.getPrioritizedContacts).mock.calls[0][0]
    expect(call).not.toHaveProperty('runId')
  })

  it('omite el filtro de runId cuando includePreviousRuns=true', async () => {
    vi.mocked(repo.getLastCompleteRunId).mockResolvedValue('run-abc-123')

    await service.getPrioritizedContacts({ page: 1, pageSize: 50, includePreviousRuns: true })

    // No debe consultar last_complete_run_id ni agregar el filtro
    expect(repo.getLastCompleteRunId).not.toHaveBeenCalled()
    const call = vi.mocked(repo.getPrioritizedContacts).mock.calls[0][0]
    expect(call).not.toHaveProperty('runId')
  })
})

// ── Historial de corridas (recompute_runs) ────────────────────────────────────

describe('UserPrioritizationService — historial de corridas', () => {
  let service: UserPrioritizationService
  let repo: UserPrioritizationRepository

  beforeEach(() => {
    MockRepo.mockClear()
    service = new UserPrioritizationService()
    repo    = MockRepo.mock.instances[0]

    vi.mocked(repo.acquireRecomputeLock).mockResolvedValue(true)
    vi.mocked(repo.releaseRecomputeLock).mockResolvedValue(true)
    vi.mocked(repo.renewRecomputeLock).mockResolvedValue(true)
    vi.mocked(repo.upsertScores).mockResolvedValue()
    vi.mocked(repo.insertRecomputeRun).mockResolvedValue()
    vi.mocked(repo.getLastMessagedDaysMap).mockResolvedValue(new Map())
    vi.mocked(repo.getLastCompleteRunId).mockResolvedValue(null)
  })

  it('registra status=success en recompute_runs cuando la corrida completa', async () => {
    vi.mocked(repo.fetchContactMetrics).mockResolvedValue([])

    await service.recomputeAll()

    expect(repo.insertRecomputeRun).toHaveBeenCalledOnce()
    expect(repo.insertRecomputeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status:            'success',
        contactsProcessed: 0,
        contactsUpdated:   0,
      }),
    )
  })

  it('registra status=failed en recompute_runs cuando hay un error inesperado', async () => {
    vi.mocked(repo.fetchContactMetrics).mockRejectedValue(new Error('conexión perdida'))

    await expect(service.recomputeAll()).rejects.toThrow('conexión perdida')

    expect(repo.insertRecomputeRun).toHaveBeenCalledOnce()
    expect(repo.insertRecomputeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status:       'failed',
        errorMessage: expect.stringContaining('conexión perdida'),
      }),
    )
  })

  it('registra status=revoked cuando el heartbeat pierde el lock', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(repo.renewRecomputeLock).mockResolvedValue(false)
      vi.mocked(repo.fetchContactMetrics).mockImplementationOnce(
        () => new Promise(res => setTimeout(() => res([]), 6000)),
      )

      const promise = service.recomputeAll({ heartbeatIntervalMs: 5000 })
      void promise.catch(() => undefined) // evita "unhandled rejection" mientras corren los timers
      await vi.advanceTimersByTimeAsync(6000)
      await expect(promise).rejects.toThrow(LockRevokedError)

      expect(repo.insertRecomputeRun).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'revoked' }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('el run_id del registro coincide con el lock_token de la corrida', async () => {
    vi.mocked(repo.fetchContactMetrics).mockResolvedValue([])

    await service.recomputeAll()

    const acquireToken = vi.mocked(repo.acquireRecomputeLock).mock.calls[0][1]
    const insertedRun  = vi.mocked(repo.insertRecomputeRun).mock.calls[0][0]

    expect(insertedRun.runId).toBe(acquireToken)
  })

  it('last_complete_run_id no se actualiza cuando la corrida falla (releaseRecomputeLock con success=false)', async () => {
    vi.mocked(repo.fetchContactMetrics).mockRejectedValue(new Error('timeout'))

    await expect(service.recomputeAll()).rejects.toThrow('timeout')

    expect(repo.releaseRecomputeLock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: expect.any(String) }),
      false,   // success=false → last_complete_run_id no se toca en el SQL
    )
  })
})

// ── Logging estructurado ──────────────────────────────────────────────────────

describe('UserPrioritizationService — logging', () => {
  let service: UserPrioritizationService
  let repo: UserPrioritizationRepository
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    MockRepo.mockClear()
    service    = new UserPrioritizationService()
    repo       = MockRepo.mock.instances[0]
    stdoutSpy  = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    vi.mocked(repo.acquireRecomputeLock).mockResolvedValue(true)
    vi.mocked(repo.releaseRecomputeLock).mockResolvedValue(true)
    vi.mocked(repo.renewRecomputeLock).mockResolvedValue(true)
    vi.mocked(repo.upsertScores).mockResolvedValue()
    vi.mocked(repo.insertRecomputeRun).mockResolvedValue()
    vi.mocked(repo.getLastMessagedDaysMap).mockResolvedValue(new Map())
    vi.mocked(repo.getLastCompleteRunId).mockResolvedValue(null)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })

  it('emite prioritization_recompute_start al iniciar', async () => {
    vi.mocked(repo.fetchContactMetrics).mockResolvedValue([])

    await service.recomputeAll()

    const written = stdoutSpy.mock.calls.map(c => String(c[0])).join('')
    expect(written).toContain('prioritization_recompute_start')
  })

  it('emite prioritization_recompute_end con status=success al completar', async () => {
    vi.mocked(repo.fetchContactMetrics).mockResolvedValue([])

    await service.recomputeAll()

    const written = stdoutSpy.mock.calls.map(c => String(c[0])).join('')
    expect(written).toContain('prioritization_recompute_end')
    expect(written).toContain('"status":"success"')
  })

  it('emite prioritization_recompute_batch por cada batch procesado', async () => {
    const contacts = [makeContact({ contactId: 'c1', lastDepositAt: daysAgo(15) })]
    vi.mocked(repo.fetchContactMetrics)
      .mockResolvedValueOnce(contacts)
      .mockResolvedValueOnce([])

    await service.recomputeAll()

    const written = stdoutSpy.mock.calls.map(c => String(c[0])).join('')
    expect(written).toContain('prioritization_recompute_batch')
    expect(written).toContain('"batch_num":1')
  })
})
