// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Webhook Verifier ─────────────────────────────────────────────────────────

describe('webhook-verifier', () => {
  const { verifyWebhookSignature, verifyWebhookChallenge } = await import('../cloud-api/webhook-verifier')
  const { createHmac } = await import('crypto')
  const SECRET = 'test_secret_abc123xyz'

  describe('verifyWebhookSignature', () => {
    it('acepta firma HMAC-SHA256 válida', () => {
      const body = Buffer.from('{"test":"payload"}')
      const sig  = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex')
      expect(verifyWebhookSignature(body, { 'x-hub-signature-256': sig }, SECRET).valid).toBe(true)
    })

    it('rechaza cuando falta el header', () => {
      const r = verifyWebhookSignature(Buffer.from('x'), {}, SECRET)
      expect(r.valid).toBe(false)
      expect(r.reason).toContain('ausente')
    })

    it('rechaza firma manipulada (timing-safe)', () => {
      const body = Buffer.from('real body')
      const sig  = 'sha256=' + 'a'.repeat(64)
      expect(verifyWebhookSignature(body, { 'x-hub-signature-256': sig }, SECRET).valid).toBe(false)
    })

    it('rechaza firma sin prefijo sha256=', () => {
      const r = verifyWebhookSignature(Buffer.from('x'), { 'x-hub-signature-256': 'invalidsig' }, SECRET)
      expect(r.valid).toBe(false)
      expect(r.reason).toContain('Formato')
    })

    it('es resistente a timing attacks (longitud incorrecta)', () => {
      const body = Buffer.from('x')
      const sig  = 'sha256=' + 'ab'  // hex muy corto
      const r    = verifyWebhookSignature(body, { 'x-hub-signature-256': sig }, SECRET)
      expect(r.valid).toBe(false)
    })
  })

  describe('verifyWebhookChallenge', () => {
    it('devuelve el challenge cuando el token coincide', () => {
      expect(verifyWebhookChallenge({ mode: 'subscribe', token: 'tok', challenge: 'ch123', verifyToken: 'tok' }))
        .toBe('ch123')
    })
    it('devuelve null con token incorrecto', () => {
      expect(verifyWebhookChallenge({ mode: 'subscribe', token: 'wrong', challenge: 'ch', verifyToken: 'tok' }))
        .toBeNull()
    })
    it('devuelve null con mode incorrecto', () => {
      expect(verifyWebhookChallenge({ mode: 'other', token: 'tok', challenge: 'ch', verifyToken: 'tok' }))
        .toBeNull()
    })
  })
})

// ─── Error Classification ─────────────────────────────────────────────────────

describe('errors', () => {
  const {
    classifyMetaError, fromHttpResponse,
    CloudApiError, TokenExpiredError, OptOutError, RateLimitError,
  } = await import('../cloud-api/errors')

  it('190 → TokenExpiredError, no reintentable', () => {
    const err = fromHttpResponse(401, { error: { code: 190, message: 'token expired', type: 'OAuthException' } })
    expect(err).toBeInstanceOf(TokenExpiredError)
    expect(err.retryable).toBe(false)
  })

  it('130429 → reintentable (rate limit)', () => {
    expect(classifyMetaError(130429).retryable).toBe(true)
  })

  it('131026 → no reintentable (opt-out)', () => {
    const { retryable, userMessage } = classifyMetaError(131026)
    expect(retryable).toBe(false)
    expect(userMessage).toContain('optado')
  })

  it('131047 → no reintentable (ventana cerrada)', () => {
    expect(classifyMetaError(131047).retryable).toBe(false)
  })

  it('RateLimitError contiene retryAfterMs', () => {
    const err = new RateLimitError(2500)
    expect(err.retryAfterMs).toBe(2500)
    expect(err.name).toBe('RateLimitError')
  })

  it('código desconocido → mensaje genérico con el código', () => {
    expect(classifyMetaError(999888).userMessage).toContain('999888')
  })
})

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

describe('circuit-breaker', () => {
  const { withCircuitBreaker, resetBreaker, CircuitBreakerOpenError } = await import('../cloud-api/infrastructure/circuit-breaker')

  beforeEach(() => resetBreaker('test-key'))
  afterEach(()  => resetBreaker('test-key'))

  it('permite llamadas en estado CLOSED', async () => {
    const result = await withCircuitBreaker('test-key', () => Promise.resolve('ok'))
    expect(result).toBe('ok')
  })

  it('abre el breaker tras N fallos consecutivos', async () => {
    const failing = () => Promise.reject(new Error('fail'))
    for (let i = 0; i < 5; i++) {
      await withCircuitBreaker('test-key', failing, { failureThreshold: 5 }).catch(() => {})
    }
    await expect(withCircuitBreaker('test-key', () => Promise.resolve('ok'), { failureThreshold: 5 }))
      .rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })

  it('rechaza inmediatamente en estado OPEN', async () => {
    const cfg = { failureThreshold: 1, cooldownMs: 60_000 }
    await withCircuitBreaker('test-key', () => Promise.reject(new Error('fail')), cfg).catch(() => {})
    await expect(withCircuitBreaker('test-key', () => Promise.resolve('x'), cfg))
      .rejects.toBeInstanceOf(CircuitBreakerOpenError)
  })

  it('cierra el breaker tras éxitos en HALF_OPEN', async () => {
    const cfg = { failureThreshold: 1, cooldownMs: 0, successThreshold: 1 }
    await withCircuitBreaker('test-key', () => Promise.reject(new Error('f')), cfg).catch(() => {})
    // Cooldown = 0 → inmediatamente HALF_OPEN
    const r = await withCircuitBreaker('test-key', () => Promise.resolve('recovered'), cfg)
    expect(r).toBe('recovered')
    // Ahora debe estar CLOSED → otra llamada debe pasar
    const r2 = await withCircuitBreaker('test-key', () => Promise.resolve('ok'), cfg)
    expect(r2).toBe('ok')
  })
})

// ─── Message Payload Builder ──────────────────────────────────────────────────

describe('buildMessagePayload', () => {
  const { buildMessagePayload } = await import('../cloud-api/infrastructure/message-sender.service')

  it('construye payload de texto correctamente', () => {
    const p = buildMessagePayload({
      phoneNumberId: 'ph1', to: '+5491112345678', type: 'text',
      text: { body: 'Hola', previewUrl: false },
    })
    expect(p.messaging_product).toBe('whatsapp')
    expect(p.type).toBe('text')
    expect((p.text as { body: string }).body).toBe('Hola')
  })

  it('incluye context cuando hay contextMessageId', () => {
    const p = buildMessagePayload({
      phoneNumberId: 'ph1', to: '+5491112345678', type: 'text',
      text: { body: 'reply' }, contextMessageId: 'wamid.abc',
    })
    expect((p.context as { message_id: string }).message_id).toBe('wamid.abc')
  })

  it('construye payload de reaction correctamente', () => {
    const p = buildMessagePayload({
      phoneNumberId: 'ph1', to: '+5491112345678', type: 'reaction',
      reaction: { messageId: 'wamid.xyz', emoji: '👍' },
    })
    expect((p.reaction as { emoji: string }).emoji).toBe('👍')
    expect((p.reaction as { message_id: string }).message_id).toBe('wamid.xyz')
  })

  it('construye payload de template correctamente', () => {
    const tmpl = { name: 'hello', language: { code: 'es' }, components: [] }
    const p    = buildMessagePayload({ phoneNumberId: 'ph1', to: '+5491112345678', type: 'template', template: tmpl })
    expect(p.template).toEqual(tmpl)
    expect(p.type).toBe('template')
  })
})

// ─── Compliance Repository (con mock de DB) ───────────────────────────────────

describe('compliance repository', () => {
  const mockQuery = vi.fn()
  vi.doMock('@/lib/db', () => ({ query: mockQuery }))

  beforeEach(() => mockQuery.mockReset())

  it('isOptedOut retorna true cuando opted_out = true en DB', async () => {
    mockQuery.mockResolvedValueOnce([{ opted_out: true }])
    const { complianceRepository } = await import('../cloud-api/repositories/compliance.repository')
    expect(await complianceRepository.isOptedOut('+5491112345678', 'ph1')).toBe(true)
  })

  it('isOptedOut retorna false cuando no hay registro', async () => {
    mockQuery.mockResolvedValueOnce([])
    const { complianceRepository } = await import('../cloud-api/repositories/compliance.repository')
    expect(await complianceRepository.isOptedOut('+5491112345678', 'ph1')).toBe(false)
  })

  it('matchesStopKeyword detecta STOP', async () => {
    mockQuery.mockResolvedValueOnce([{ keyword: 'STOP' }])
    const { complianceRepository } = await import('../cloud-api/repositories/compliance.repository')
    expect(await complianceRepository.matchesStopKeyword('STOP')).toBe(true)
  })

  it('matchesStopKeyword no detecta texto normal', async () => {
    mockQuery.mockResolvedValueOnce([])
    const { complianceRepository } = await import('../cloud-api/repositories/compliance.repository')
    expect(await complianceRepository.matchesStopKeyword('Hola, necesito ayuda')).toBe(false)
  })
})

// ─── Send Message Use Case (integración con mocks) ───────────────────────────

describe('SendMessageUseCase', () => {
  const mockQuery = vi.fn()
  vi.doMock('@/lib/db', () => ({ query: mockQuery }))

  beforeEach(() => mockQuery.mockReset())

  it('lanza OptOutError si el contacto tiene opt-out', async () => {
    // isOptedOut = true
    mockQuery.mockResolvedValueOnce([{ opted_out: true }])

    const { SendMessageUseCase } = await import('../cloud-api/use-cases/send-message.use-case')
    const { OptOutError }        = await import('../cloud-api/errors')
    const uc = new SendMessageUseCase()

    await expect(uc.execute({
      request: { phoneNumberId: 'ph1', to: '+5491112345678', type: 'text', text: { body: 'hi' } },
    })).rejects.toBeInstanceOf(OptOutError)
  })

  it('lanza ConversationWindowError para texto libre sin ventana abierta', async () => {
    mockQuery
      .mockResolvedValueOnce([{ opted_out: false }])      // isOptedOut
      .mockResolvedValueOnce([{ window_expires_at: null, window_type: null }]) // findWindow

    const { SendMessageUseCase }    = await import('../cloud-api/use-cases/send-message.use-case')
    const { ConversationWindowError } = await import('../cloud-api/errors')
    const uc = new SendMessageUseCase()

    await expect(uc.execute({
      request: { phoneNumberId: 'ph1', to: '+5491112345678', type: 'text', text: { body: 'hi' } },
    })).rejects.toBeInstanceOf(ConversationWindowError)
  })
})
