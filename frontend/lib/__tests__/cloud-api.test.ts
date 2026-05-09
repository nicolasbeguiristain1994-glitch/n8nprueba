// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { verifyWebhookSignature, verifyWebhookChallenge } from '../cloud-api/webhook-verifier'
import { classifyMetaError, fromHttpResponse, CloudApiError, TokenExpiredError } from '../cloud-api/errors'
import { checkAndHandleStopKeyword } from '../cloud-api/compliance'

// ─── Webhook Verifier ─────────────────────────────────────────────────────────

describe('verifyWebhookSignature', () => {
  const APP_SECRET = 'test_secret_12345'

  it('acepta una firma HMAC-SHA256 válida', () => {
    const { createHmac } = require('crypto')
    const body      = Buffer.from('{"test":"payload"}')
    const signature = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex')

    const result = verifyWebhookSignature(body, { 'x-hub-signature-256': signature }, APP_SECRET)
    expect(result.valid).toBe(true)
  })

  it('rechaza cuando el header de firma falta', () => {
    const result = verifyWebhookSignature(Buffer.from('body'), {}, APP_SECRET)
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('ausente')
  })

  it('rechaza firma inválida', () => {
    const result = verifyWebhookSignature(
      Buffer.from('body'),
      { 'x-hub-signature-256': 'sha256=badfirma1234567890abcdef1234567890abcdef1234567890abcdef1234567890' },
      APP_SECRET,
    )
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('no coincide')
  })

  it('rechaza firma sin prefijo sha256=', () => {
    const result = verifyWebhookSignature(
      Buffer.from('body'),
      { 'x-hub-signature-256': 'invalidsignature' },
      APP_SECRET,
    )
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('Formato')
  })
})

describe('verifyWebhookChallenge', () => {
  it('retorna el challenge cuando el token coincide', () => {
    const challenge = verifyWebhookChallenge({
      mode:        'subscribe',
      token:       'mi_token_secreto',
      challenge:   'abc123',
      verifyToken: 'mi_token_secreto',
    })
    expect(challenge).toBe('abc123')
  })

  it('retorna null cuando el token no coincide', () => {
    const challenge = verifyWebhookChallenge({
      mode:        'subscribe',
      token:       'token_incorrecto',
      challenge:   'abc123',
      verifyToken: 'mi_token_secreto',
    })
    expect(challenge).toBeNull()
  })

  it('retorna null cuando mode no es subscribe', () => {
    const challenge = verifyWebhookChallenge({
      mode:        'unsubscribe',
      token:       'mi_token_secreto',
      challenge:   'abc123',
      verifyToken: 'mi_token_secreto',
    })
    expect(challenge).toBeNull()
  })
})

// ─── Error Classification ─────────────────────────────────────────────────────

describe('classifyMetaError', () => {
  it('clasifica 190 como no reintentable (token expirado)', () => {
    const result = classifyMetaError(190)
    expect(result.retryable).toBe(false)
    expect(result.userMessage).toContain('token')
  })

  it('clasifica 130429 como reintentable (rate limit)', () => {
    const result = classifyMetaError(130429)
    expect(result.retryable).toBe(true)
  })

  it('clasifica 131026 como no reintentable (opt-out)', () => {
    const result = classifyMetaError(131026)
    expect(result.retryable).toBe(false)
    expect(result.userMessage).toContain('optado')
  })

  it('clasifica 131047 como no reintentable (ventana cerrada)', () => {
    const result = classifyMetaError(131047)
    expect(result.retryable).toBe(false)
    expect(result.userMessage).toContain('plantilla')
  })

  it('devuelve mensaje genérico para código desconocido', () => {
    const result = classifyMetaError(999999)
    expect(result.userMessage).toContain('999999')
  })
})

describe('fromHttpResponse', () => {
  it('lanza TokenExpiredError para código 190', () => {
    const err = fromHttpResponse(401, {
      error: { code: 190, message: 'Invalid OAuth token', type: 'OAuthException' },
    })
    expect(err).toBeInstanceOf(TokenExpiredError)
  })

  it('lanza CloudApiError con mensaje de Meta', () => {
    const err = fromHttpResponse(400, {
      error: { code: 131047, message: 'Re-engagement message', type: 'GraphMethodException', fbtrace_id: 'ABC' },
    })
    expect(err).toBeInstanceOf(CloudApiError)
    expect(err.message).toContain('plantilla')
  })
})

// ─── Compliance — Stop Keywords ───────────────────────────────────────────────

describe('checkAndHandleStopKeyword', () => {
  const mockQuery = vi.fn()

  beforeEach(() => {
    vi.doMock('@/lib/db', () => ({ query: mockQuery }))
    mockQuery.mockReset()
  })

  it('detecta la keyword STOP', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ keyword: 'STOP' }] })  // stop keyword check
      .mockResolvedValueOnce({ rows: [] })                       // opt_out upsert
      .mockResolvedValueOnce({ rows: [] })                       // consent log insert

    const { checkAndHandleStopKeyword: fn } = await import('../cloud-api/compliance')
    const result = await fn('STOP', '+5491112345678', 'phone123', 'wamid123')
    expect(result).toBe(true)
  })

  it('no detecta mensajes normales como opt-out', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { checkAndHandleStopKeyword: fn } = await import('../cloud-api/compliance')
    const result = await fn('Hola! Necesito ayuda', '+5491112345678', 'phone123', 'wamid123')
    expect(result).toBe(false)
  })

  it('detecta BAJA en español', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ keyword: 'BAJA' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const { checkAndHandleStopKeyword: fn } = await import('../cloud-api/compliance')
    const result = await fn('baja', '+5491112345678', 'phone123', 'wamid123')
    expect(result).toBe(true)
  })
})

// ─── Rate Limiter (test de lógica, no de Redis) ───────────────────────────────
// Los tests de integración de rate limiter requieren Redis real.
// Para CI, mockear Redis y verificar la lógica de manejo de errores.

describe('rate limiter error handling', () => {
  it('permite el paso cuando Redis no está disponible (fail-open)', async () => {
    vi.doMock('redis', () => ({
      createClient: () => ({
        connect: () => Promise.reject(new Error('Redis unavailable')),
        eval:    () => Promise.reject(new Error('Redis unavailable')),
      }),
    }))

    const { checkRateLimit } = await import('../cloud-api/rate-limiter')
    const result = await checkRateLimit('test_number_id')
    expect(result.allowed).toBe(true)
  })
})
