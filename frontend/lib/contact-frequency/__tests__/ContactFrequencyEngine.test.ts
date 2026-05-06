/**
 * ContactFrequencyEngine.test.ts
 *
 * Tests de integración del motor principal.
 * Mockea @/lib/db para aislar la lógica de negocio.
 *
 * Cobertura:
 *  ─ evaluate(): ALLOW / DELAY / BLOCK / primer envío / reglas VIP
 *  ─ evaluate(): sin reglas → DEFAULT_GLOBAL_RULE
 *  ─ evaluate(): propagación de errores de DB
 *  ─ atomicEvaluateAndRecord(): advisory lock + pre-registro en ALLOW/DELAY
 *  ─ atomicEvaluateAndRecord(): sin registro en BLOCK
 *  ─ atomicEvaluateAndRecord(): idempotencia vía ON CONFLICT
 *  ─ atomicEvaluateAndRecord(): propagación de errores
 *  ─ recordSend(): parámetros, null, sin recipientId
 *
 * Mejora respecto a la versión anterior:
 *  Las aserciones sobre queries usan expect.stringContaining + expect.arrayContaining
 *  en lugar de acceder por índice a mockQuery.mock.calls[N], eliminando la
 *  dependencia en el orden de llamadas.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContactFrequencyEngine } from '../ContactFrequencyEngine'
import { DEFAULT_GLOBAL_RULE }    from '../rules'
import type {
  FrequencyEvaluationInput,
  RecordSendInput,
} from '../types'
import type { PoolClient } from 'pg'

// ── Mock de @/lib/db ──────────────────────────────────────────────────────────

vi.mock('@/lib/db', () => ({
  query:           vi.fn(),
  withTransaction: vi.fn(),
  pool:            { query: vi.fn() },
}))

import * as db from '@/lib/db'
const mockQuery           = vi.mocked(db.query)
const mockWithTransaction = vi.mocked(db.withTransaction)

// ── Constantes de test ────────────────────────────────────────────────────────

const CONTACT_ID   = 'contact-0000-0000-0000-000000000001'
const OPERATOR_ID  = 'operator-000-0000-0000-000000000001'
const CAMPAIGN_ID  = 'campaign-000-0000-0000-000000000001'
const RECIPIENT_ID = 'recipient-00-0000-0000-000000000001'

// ── Perfiles de frecuencia simulados ─────────────────────────────────────────

/** Contacto sin envíos previos. */
const profileClean = [{ sent_today: '0', sent_week: '0', last_sent_at: null }]

/** Contacto con 1 envío hoy → bloqueo diario con regla default (max_per_day=1). */
const profileDailyLimit = [{
  sent_today:   '1',
  sent_week:    '1',
  last_sent_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
}]

/** Contacto con 2 envíos esta semana → bloqueo semanal con regla default (max_per_week=2). */
const profileWeeklyLimit = [{
  sent_today:   '0',
  sent_week:    '2',
  last_sent_at: new Date(Date.now() - 60 * 3600 * 1000).toISOString(),
}]

/** Contacto con cool-down activo (10h, mínimo 48h). */
const profileCooldown = [{
  sent_today:   '0',
  sent_week:    '1',
  last_sent_at: new Date(Date.now() - 10 * 3600 * 1000).toISOString(),
}]

/** Contacto elegible: 1 envío esta semana, cool-down superado (72h). */
const profileOneSentWeekOld = [{
  sent_today:   '0',
  sent_week:    '1',
  last_sent_at: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
}]

/** Perfil para escenario DELAY con reglas VIP (ver ruleVip). */
const profileVipDelay = [{
  sent_today:   '1',
  sent_week:    '3',
  last_sent_at: new Date(Date.now() - 14 * 3600 * 1000).toISOString(),
}]

// ── Reglas simuladas ──────────────────────────────────────────────────────────

/** Regla global por defecto tal como la retornaría la DB. */
const rulesDefault = [{
  id:                       DEFAULT_GLOBAL_RULE.id,
  operator_id:              null,
  seg_monto:                null,
  seg_actividad:            null,
  max_per_day:              '1',
  max_per_week:             '2',
  min_hours_between_sends:  '48',
  is_active:                true,
  created_at:               new Date(0).toISOString(),
  updated_at:               new Date(0).toISOString(),
}]

/**
 * Regla VIP: más permisiva, para probar DELAY.
 * max_per_day=3, max_per_week=7, min_hours=12
 */
const rulesVip = [{
  id:                       'vip-rule-0000-0000-0000-000000000001',
  operator_id:              OPERATOR_ID,
  seg_monto:                'vip',
  seg_actividad:            null,
  max_per_day:              '3',
  max_per_week:             '7',
  min_hours_between_sends:  '12',
  is_active:                true,
  created_at:               new Date('2025-01-01').toISOString(),
  updated_at:               new Date('2025-01-01').toISOString(),
}]

// ── Factories ─────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<FrequencyEvaluationInput> = {}): FrequencyEvaluationInput {
  return { contactId: CONTACT_ID, operatorId: OPERATOR_ID, campaignId: CAMPAIGN_ID, ...overrides }
}

function makeRecordInput(overrides: Partial<RecordSendInput> = {}): RecordSendInput {
  return {
    contactId:           CONTACT_ID,
    campaignId:          CAMPAIGN_ID,
    operatorId:          OPERATOR_ID,
    phoneNumber:         '+5491199999999',
    campaignRecipientId: RECIPIENT_ID,
    ...overrides,
  }
}

/** Configura mockQuery para responder perfil y luego reglas. */
function mockEvaluateQueries(profile: unknown[], rules: unknown[]) {
  mockQuery
    .mockResolvedValueOnce(profile as never)
    .mockResolvedValueOnce(rules  as never)
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // resetAllMocks limpia tanto el historial como los valores encolados con *Once.
  // clearAllMocks solo limpia el historial — los Once acumulados contaminan el siguiente test.
  vi.resetAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════════════
// evaluate()
// ═══════════════════════════════════════════════════════════════════════════════

describe('ContactFrequencyEngine.evaluate()', () => {

  it('ALLOW: contacto limpio, primer envío', async () => {
    mockEvaluateQueries(profileClean, rulesDefault)

    const result = await ContactFrequencyEngine.evaluate(makeInput())

    expect(result.decision).toBe('ALLOW')
    expect(result.riskScore).toBe(0)
    expect(result.profile.sentToday).toBe(0)
    expect(result.profile.sentThisWeek).toBe(0)
    expect(result.profile.lastSentAt).toBeNull()
    expect(result.evaluatedAt).toBeInstanceOf(Date)
  })

  it('ALLOW: 1 envío esta semana, cool-down superado (72h > 48h)', async () => {
    // weeklyScore = 35×0.5 = 17.5
    // cooldownScore = 25×(1 - 72/96) = 25×0.25 = 6.25
    // Total ≈ 23.75 → ALLOW
    mockEvaluateQueries(profileOneSentWeekOld, rulesDefault)

    const result = await ContactFrequencyEngine.evaluate(makeInput())

    expect(result.decision).toBe('ALLOW')
    expect(result.riskScore).toBeLessThanOrEqual(30)
  })

  it('DELAY: reglas VIP con contacto parcialmente activo', async () => {
    // VIP: max_per_day=3, max_per_week=7, min_hours=12
    // sentToday=1, sentThisWeek=3, hoursSinceLastSend=14h → score≈39 → DELAY
    mockEvaluateQueries(profileVipDelay, rulesVip)

    const result = await ContactFrequencyEngine.evaluate(makeInput({ segMonto: 'vip' }))

    expect(result.decision).toBe('DELAY')
    expect(result.riskScore).toBeGreaterThan(30)
    expect(result.riskScore).toBeLessThanOrEqual(60)
    expect(result.applicableRule.max_per_day).toBe(3)
    expect(result.applicableRule.max_per_week).toBe(7)
  })

  it('BLOCK: límite diario alcanzado', async () => {
    mockEvaluateQueries(profileDailyLimit, rulesDefault)

    const result = await ContactFrequencyEngine.evaluate(makeInput())

    expect(result.decision).toBe('BLOCK')
    expect(result.riskScore).toBe(100)
    expect(result.reason).toContain('Límite diario')
  })

  it('BLOCK: límite semanal alcanzado', async () => {
    mockEvaluateQueries(profileWeeklyLimit, rulesDefault)

    const result = await ContactFrequencyEngine.evaluate(makeInput())

    expect(result.decision).toBe('BLOCK')
    expect(result.riskScore).toBe(100)
    expect(result.reason).toContain('Límite semanal')
  })

  it('BLOCK: cool-down activo (10h, mínimo 48h)', async () => {
    mockEvaluateQueries(profileCooldown, rulesDefault)

    const result = await ContactFrequencyEngine.evaluate(makeInput())

    expect(result.decision).toBe('BLOCK')
    expect(result.riskScore).toBe(100)
    expect(result.reason).toContain('Cool-down activo')
  })

  it('usa DEFAULT_GLOBAL_RULE cuando no hay reglas en DB', async () => {
    mockQuery
      .mockResolvedValueOnce(profileClean as never)
      .mockResolvedValueOnce([] as never)  // sin reglas

    const result = await ContactFrequencyEngine.evaluate(makeInput())

    expect(result.applicableRule.id).toBe(DEFAULT_GLOBAL_RULE.id)
    expect(result.decision).toBe('ALLOW')
  })

  it('retorna la regla VIP cuando se pasa segMonto=vip', async () => {
    mockEvaluateQueries(profileClean, rulesVip)

    const result = await ContactFrequencyEngine.evaluate(makeInput({ segMonto: 'vip' }))

    expect(result.applicableRule.max_per_day).toBe(3)
  })

  it('evaluatedAt es una fecha dentro del rango de ejecución', async () => {
    mockEvaluateQueries(profileClean, rulesDefault)

    const before = Date.now()
    const result = await ContactFrequencyEngine.evaluate(makeInput())
    const after  = Date.now()

    expect(result.evaluatedAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(result.evaluatedAt.getTime()).toBeLessThanOrEqual(after)
  })

  it('pasa operatorId a la query de reglas (no acoplado al orden)', async () => {
    mockEvaluateQueries(profileClean, rulesDefault)

    await ContactFrequencyEngine.evaluate(makeInput({ operatorId: OPERATOR_ID }))

    // Verifica que findActiveRulesForContext fue llamado con el operatorId correcto
    // usando objectContaining en lugar de acceso por índice
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('contact_frequency_rules'),
      expect.arrayContaining([OPERATOR_ID]),
    )
  })

  it('operatorId null → pasa null a la query de reglas', async () => {
    mockEvaluateQueries(profileClean, rulesDefault)

    await ContactFrequencyEngine.evaluate(makeInput({ operatorId: null }))

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('contact_frequency_rules'),
      expect.arrayContaining([null]),
    )
  })

  it('propaga errores de DB sin silenciarlos', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'))

    await expect(
      ContactFrequencyEngine.evaluate(makeInput())
    ).rejects.toThrow('connection refused')
  })

})

// ═══════════════════════════════════════════════════════════════════════════════
// atomicEvaluateAndRecord()
// ═══════════════════════════════════════════════════════════════════════════════

describe('ContactFrequencyEngine.atomicEvaluateAndRecord()', () => {

  /**
   * Mock de withTransaction: ejecuta el callback con un cliente falso.
   * El cliente fake responde con { rows: [] } por defecto a cualquier query.
   */
  function setupAtomicMock(
    profile: unknown[] = profileClean,
    rules: unknown[]   = rulesDefault,
  ) {
    const mockTxClient = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })       // advisory_lock
        .mockResolvedValueOnce({ rows: profile })  // getFrequencyProfile
        .mockResolvedValueOnce({ rows: rules })    // findActiveRulesForContext
        .mockResolvedValue({ rows: [] }),           // INSERT + llamadas extra
    }
    mockWithTransaction.mockImplementation(async (fn: (c: PoolClient) => Promise<unknown>) =>
      fn(mockTxClient as unknown as PoolClient)
    )
    return mockTxClient
  }

  it('ALLOW: adquiere advisory lock y pre-registra el envío', async () => {
    const mockTxClient = setupAtomicMock(profileClean, rulesDefault)

    const result = await ContactFrequencyEngine.atomicEvaluateAndRecord(
      makeInput(),
      makeRecordInput(),
    )

    expect(result.decision).toBe('ALLOW')

    // Lock fue adquirido con el contactId correcto
    expect(mockTxClient.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.arrayContaining([CONTACT_ID]),
    )

    // Registro fue insertado (en ALLOW, dentro de la transacción)
    expect(mockTxClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO contact_send_history'),
      expect.arrayContaining([CONTACT_ID, CAMPAIGN_ID, OPERATOR_ID]),
    )
  })

  it('DELAY: también pre-registra el envío (no es BLOCK)', async () => {
    // VIP: sentToday=1, sentThisWeek=3, hoursSinceLastSend=14 → DELAY
    const mockTxClient = setupAtomicMock(profileVipDelay, rulesVip)

    const result = await ContactFrequencyEngine.atomicEvaluateAndRecord(
      makeInput({ segMonto: 'vip' }),
      makeRecordInput(),
    )

    expect(result.decision).toBe('DELAY')

    // Lock adquirido
    expect(mockTxClient.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.anything(),
    )

    // Registro insertado (DELAY no es BLOCK, debe registrar)
    expect(mockTxClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO contact_send_history'),
      expect.anything(),
    )
  })

  it('BLOCK: adquiere el lock pero NO inserta registro', async () => {
    const mockTxClient = setupAtomicMock(profileDailyLimit, rulesDefault)

    const result = await ContactFrequencyEngine.atomicEvaluateAndRecord(
      makeInput(),
      makeRecordInput(),
    )

    expect(result.decision).toBe('BLOCK')

    // Lock sí fue adquirido (siempre se adquiere para serializar)
    expect(mockTxClient.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.anything(),
    )

    // NO hubo INSERT para BLOCK
    expect(mockTxClient.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO contact_send_history'),
      expect.anything(),
    )
  })

  it('el lock usa el namespace correcto (50) y el contactId como clave', async () => {
    const mockTxClient = setupAtomicMock(profileClean, rulesDefault)

    await ContactFrequencyEngine.atomicEvaluateAndRecord(makeInput(), makeRecordInput())

    // Namespace = 50 (número de migración), key = contactId
    expect(mockTxClient.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      [50, CONTACT_ID],
    )
  })

  it('usa ON CONFLICT DO NOTHING para idempotencia (mismo recipientId)', async () => {
    const mockTxClient = setupAtomicMock(profileClean, rulesDefault)

    await ContactFrequencyEngine.atomicEvaluateAndRecord(makeInput(), makeRecordInput())

    // El INSERT debe tener la cláusula ON CONFLICT para idempotencia
    expect(mockTxClient.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT'),
      expect.anything(),
    )
  })

  it('retorna FrequencyEvaluationResult completo con evaluatedAt', async () => {
    setupAtomicMock(profileClean, rulesDefault)

    const before = Date.now()
    const result = await ContactFrequencyEngine.atomicEvaluateAndRecord(
      makeInput(), makeRecordInput(),
    )
    const after = Date.now()

    expect(result.decision).toBeDefined()
    expect(result.riskScore).toBeGreaterThanOrEqual(0)
    expect(result.reason).toBeTruthy()
    expect(result.profile).toBeDefined()
    expect(result.applicableRule).toBeDefined()
    expect(result.evaluatedAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(result.evaluatedAt.getTime()).toBeLessThanOrEqual(after)
  })

  it('propaga errores de withTransaction (fallo de lock o DB)', async () => {
    mockWithTransaction.mockRejectedValueOnce(new Error('could not connect'))

    await expect(
      ContactFrequencyEngine.atomicEvaluateAndRecord(makeInput(), makeRecordInput())
    ).rejects.toThrow('could not connect')
  })

  it('usa DEFAULT_GLOBAL_RULE cuando DB no retorna reglas', async () => {
    setupAtomicMock(profileClean, [])

    const result = await ContactFrequencyEngine.atomicEvaluateAndRecord(
      makeInput(), makeRecordInput(),
    )

    expect(result.applicableRule.id).toBe(DEFAULT_GLOBAL_RULE.id)
  })

})

// ═══════════════════════════════════════════════════════════════════════════════
// recordSend()
// ═══════════════════════════════════════════════════════════════════════════════

describe('ContactFrequencyEngine.recordSend()', () => {

  it('llama a query con los parámetros correctos', async () => {
    mockQuery.mockResolvedValueOnce([] as never)

    await ContactFrequencyEngine.recordSend(makeRecordInput())

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO contact_send_history'),
      expect.arrayContaining([CONTACT_ID, CAMPAIGN_ID, OPERATOR_ID, '+5491199999999', RECIPIENT_ID]),
    )
  })

  it('funciona con campaignId null (envío manual)', async () => {
    mockQuery.mockResolvedValueOnce([] as never)

    await expect(
      ContactFrequencyEngine.recordSend(makeRecordInput({ campaignId: null, operatorId: null }))
    ).resolves.not.toThrow()

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO contact_send_history'),
      expect.arrayContaining([CONTACT_ID, null, null]),
    )
  })

  it('sin campaignRecipientId → pasa null al último parámetro', async () => {
    mockQuery.mockResolvedValueOnce([] as never)

    await ContactFrequencyEngine.recordSend(
      makeRecordInput({ campaignRecipientId: undefined })
    )

    expect(mockQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([null]),  // campaignRecipientId = null
    )
  })

  it('propaga errores de DB', async () => {
    mockQuery.mockRejectedValueOnce(new Error('unique violation'))

    await expect(
      ContactFrequencyEngine.recordSend(makeRecordInput())
    ).rejects.toThrow('unique violation')
  })

})

// ═══════════════════════════════════════════════════════════════════════════════
// Repositorios expuestos
// ═══════════════════════════════════════════════════════════════════════════════

describe('ContactFrequencyEngine — repositorios expuestos', () => {

  it('rulesRepository está disponible', () => {
    expect(ContactFrequencyEngine.rulesRepository).toBeDefined()
  })

  it('historyRepository está disponible', () => {
    expect(ContactFrequencyEngine.historyRepository).toBeDefined()
  })

})
