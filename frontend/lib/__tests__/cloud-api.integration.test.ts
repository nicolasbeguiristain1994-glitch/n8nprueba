// @vitest-environment node
//
// Tests de integración del módulo Cloud API.
// Mockean en la frontera (DB + Meta API), pero dejan correr el código real de
// use cases, handlers y repositories sin mocks internos.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mocks globales (hoistados antes de cualquier import) ─────────────────────

vi.mock('@/lib/db', () => ({ query: vi.fn() }))

vi.mock('@/lib/cloud-api/token-store', () => ({
  getTokenForNumber: vi.fn().mockResolvedValue('mock_access_token'),
  storeToken:        vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/cloud-api/rate-limiter', () => ({
  enforceRateLimit: vi.fn().mockResolvedValue(undefined),
  waitForRateLimit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/cloud-api/coexistence-sync', () => ({
  runInitialCoexistenceSync: vi.fn().mockResolvedValue({
    contacts: { syncType: 'smb_app_state_sync', status: 'in_progress' },
    history:  { syncType: 'history',             status: 'in_progress' },
  }),
}))

vi.mock('@/lib/cloud-api/message-queue', () => ({
  enqueueMessage:  vi.fn().mockResolvedValue('job_id_mock'),
  moveToDeadLetter: vi.fn().mockResolvedValue(undefined),
}))

// ─── Import de mocks configurables ───────────────────────────────────────────

import { query } from '@/lib/db'

const mockQuery = query as unknown as ReturnType<typeof vi.fn>

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ─── Test 1: Onboarding - Embedded Signup → estado code_sent ─────────────────
//
// Simula el flujo completo: code OAuth → token long-lived → phone info → OTP.
// Verifica que el use case orqueste correctamente las llamadas externas y DB.

describe('OnboardCoexistenceUseCase – Embedded Signup → OTP', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockQuery.mockReset()
    mockFetch.mockReset()
    process.env.META_APP_ID           = 'test_app_id_123'
    process.env.META_APP_SECRET       = 'test_app_secret_456'
    process.env.TOKEN_ENCRYPTION_KEY  = 'test_enc_key_32_chars_minimum_ok!'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('orquesta el flujo completo y devuelve status code_sent', async () => {
    // Meta API: 4 llamadas en secuencia
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: 'short_token', token_type: 'bearer' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'long_token',  expires_in: 0 }))
      .mockResolvedValueOnce(jsonResponse({
        id:                        'ph_test_001',
        display_phone_number:      '+5491100001111',
        verified_name:             'Empresa de Prueba',
        code_verification_status:  'NOT_VERIFIED',
      }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))  // OTP request

    // DB: findByPhoneNumberId (nuevo) → insert → updateStatus
    mockQuery
      .mockResolvedValueOnce([])                          // findByPhoneNumberId → null
      .mockResolvedValueOnce([{ id: 'cloud_num_abc' }])  // insert RETURNING id
      .mockResolvedValueOnce([])                          // updateStatus → code_sent

    const { OnboardCoexistenceUseCase } = await import('@/lib/cloud-api/use-cases/onboard-coexistence.use-case')
    const uc = new OnboardCoexistenceUseCase()

    const result = await uc.execute(
      { code: 'oauth_code_xyz', wabaId: 'waba_test_456', phoneNumberId: 'ph_test_001' },
      'user_initiator_001',
    )

    // Estado y IDs correctos
    expect(result.status).toBe('code_sent')
    expect(result.cloudNumberId).toBe('cloud_num_abc')
    expect(result.phoneNumberId).toBe('ph_test_001')
    expect(result.displayPhone).toBe('+5491100001111')

    // Las 4 llamadas a Meta API ocurrieron
    expect(mockFetch).toHaveBeenCalledTimes(4)

    // Primera llamada: exchange code
    expect(mockFetch.mock.calls[0][0]).toContain('oauth/access_token')

    // Las 3 queries DB ocurrieron
    expect(mockQuery).toHaveBeenCalledTimes(3)
  })

  it('activa directamente si el número ya está VERIFIED (re-onboarding)', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ access_token: 'short_token' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'long_token', expires_in: 0 }))
      .mockResolvedValueOnce(jsonResponse({
        id:                        'ph_test_002',
        display_phone_number:      '+5491100002222',
        verified_name:             'Empresa Verificada',
        code_verification_status:  'VERIFIED',
      }))
      // subscribeFields (WABA webhooks)
      .mockResolvedValueOnce(jsonResponse({ success: true }))

    // findByPhoneNumberId (existente) → upsertForReOnboarding → updateStatus(active) → storeToken (query)
    mockQuery
      .mockResolvedValueOnce([{ id: 'existing_cn', waba_id: 'waba_456', phone_number_id: 'ph_test_002',
        display_phone: '+5491100002222', verified_name: 'old', status: 'active',
        coexistence_enabled: true, contacts_synced: false, history_synced: false,
        history_sync_days: 180, quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K',
        whatsapp_line_id: null, onboarded_at: null, token_expires_at: null,
        created_at: new Date(), updated_at: new Date() }])  // findByPhoneNumberId
      .mockResolvedValueOnce([])  // upsertForReOnboarding
      .mockResolvedValueOnce([])  // updateStatus(active)
      .mockResolvedValueOnce([])  // storeToken (updateToken)

    const { OnboardCoexistenceUseCase } = await import('@/lib/cloud-api/use-cases/onboard-coexistence.use-case')
    const uc = new OnboardCoexistenceUseCase()

    const result = await uc.execute(
      { code: 'oauth_code_abc', wabaId: 'waba_456', phoneNumberId: 'ph_test_002' },
      'user_002',
    )

    expect(result.status).toBe('active')
    expect(result.cloudNumberId).toBe('existing_cn')
  })
})

// ─── Test 2: Inbound webhook – correlationId propagado en todos los logs ──────
//
// Verifica que el correlationId generado en el POST del webhook aparece en
// cada entrada de log estructurado emitido por el handler inbound.

describe('handleInboundMessage – correlationId propagado en todos los logs', () => {
  const correlationId = 'integration-test-cid-abc123'
  const mockFetch     = vi.fn()
  const infoSpy       = vi.spyOn(console, 'info').mockImplementation(() => {})

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockQuery.mockReset()
    infoSpy.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('el correlationId aparece en todos los logs info del flujo inbound', async () => {
    // matchesStopKeyword → no es STOP
    // openWindow
    // upsertWithMessage → conv id
    // insertInbound
    mockQuery
      .mockResolvedValueOnce([])               // matchesStopKeyword → no match
      .mockResolvedValueOnce([])               // openWindow
      .mockResolvedValueOnce([{ id: 'conv_integration_001' }])  // upsertWithMessage
      .mockResolvedValueOnce([])               // insertInbound

    const { handleInboundMessage } = await import('@/lib/cloud-api/webhook-handlers/inbound-message.handler')

    const msg = {
      id: 'wamid.integration001', from: '5491100003333', type: 'text' as const,
      text: { body: 'Hola, quiero información' }, timestamp: '1700000000',
    }

    await handleInboundMessage('ph_integration', msg as never, [], correlationId)

    // Parsear todos los logs JSON emitidos
    const jsonLogs = infoSpy.mock.calls
      .map(call => { try { return JSON.parse(call[0] as string) } catch { return null } })
      .filter(Boolean)

    // Todos los logs estructurados deben tener el correlationId
    expect(jsonLogs.length).toBeGreaterThan(0)
    expect(jsonLogs.every(log => log.correlationId === correlationId)).toBe(true)

    // El log final debe indicar 'processed'
    expect(jsonLogs.some(log => log.message === 'processed')).toBe(true)

    // El phoneNumberId debe estar presente
    expect(jsonLogs.every(log => log.phoneNumberId === 'ph_integration')).toBe(true)
  })

  it('detecta STOP keyword, registra opt-out y propaga correlationId', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // matchesStopKeyword → true
    // openWindow
    // recordOptOut (2 queries: matchesKeyword result + recordOptOut)
    mockQuery
      .mockResolvedValueOnce([])                      // openWindow
      .mockResolvedValueOnce([{ keyword: 'STOP' }])   // matchesStopKeyword → hit
      .mockResolvedValueOnce([])                      // recordOptOut insert

    const { handleInboundMessage } = await import('@/lib/cloud-api/webhook-handlers/inbound-message.handler')

    const msg = {
      id: 'wamid.stop001', from: '5491100004444', type: 'text' as const,
      text: { body: 'STOP' }, timestamp: '1700000001',
    }

    await handleInboundMessage('ph_integration', msg as never, [], correlationId)

    // El log de opt_out debe aparecer con el correlationId
    const allLogs = [...infoSpy.mock.calls, ...warnSpy.mock.calls]
      .map(call => { try { return JSON.parse(call[0] as string) } catch { return null } })
      .filter(Boolean)

    expect(allLogs.some(log => log.correlationId === correlationId && log.message === 'opt_out detected')).toBe(true)

    warnSpy.mockRestore()
  })
})

// ─── Test 3: SendMessageUseCase – flujo completo de envío exitoso ─────────────
//
// Template message (sin validación de ventana).
// Verifica: compliance → rate limit → API call → persistencia → correlationId en logs.

describe('SendMessageUseCase – envío exitoso de template', () => {
  const correlationId = 'send-integration-cid-xyz789'
  const infoSpy       = vi.spyOn(console, 'info').mockImplementation(() => {})
  const mockFetch     = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
    mockQuery.mockReset()
    infoSpy.mockClear()
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('orquesta compliance → send → persist y retorna status sent', async () => {
    // isOptedOut → false
    // upsertForOutbound → conv id
    // insertOutbound
    mockQuery
      .mockResolvedValueOnce([{ opted_out: false }])          // isOptedOut
      .mockResolvedValueOnce([{ id: 'conv_send_001' }])       // upsertForOutbound
      .mockResolvedValueOnce([])                              // insertOutbound

    // Meta Graph API → success
    mockFetch.mockResolvedValueOnce(jsonResponse({
      messages: [{ id: 'wamid.send_success_001' }],
    }))

    const { SendMessageUseCase } = await import('@/lib/cloud-api/use-cases/send-message.use-case')
    const uc = new SendMessageUseCase()

    const result = await uc.execute({
      request: {
        phoneNumberId: 'ph_send_test',
        to:            '+5491100005555',
        type:          'template',
        template:      { name: 'bienvenida_v1', language: { code: 'es_AR' }, components: [] },
      },
      correlationId,
    })

    expect(result.status).toBe('sent')
    expect(result.wamid).toBe('wamid.send_success_001')
    expect(result.messageId).toBeDefined()

    // Meta API fue llamada con Authorization header
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toContain('/messages')
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer mock_access_token',
    })

    // El correlationId aparece en los logs estructurados
    const jsonLogs = infoSpy.mock.calls
      .map(call => { try { return JSON.parse(call[0] as string) } catch { return null } })
      .filter(Boolean)

    expect(jsonLogs.some(log => log.correlationId === correlationId && log.message === 'sent')).toBe(true)
    expect(jsonLogs.some(log => log.phoneNumberId === 'ph_send_test')).toBe(true)
  })

  it('lanza OptOutError antes de llamar a Meta API', async () => {
    mockQuery.mockResolvedValueOnce([{ opted_out: true }])  // isOptedOut → true

    const { SendMessageUseCase } = await import('@/lib/cloud-api/use-cases/send-message.use-case')
    const { OptOutError }        = await import('@/lib/cloud-api/errors')
    const uc = new SendMessageUseCase()

    await expect(uc.execute({
      request: { phoneNumberId: 'ph_send_test', to: '+5491100006666', type: 'template',
        template: { name: 't', language: { code: 'es' }, components: [] } },
      correlationId,
    })).rejects.toBeInstanceOf(OptOutError)

    // Meta API nunca fue llamada
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
