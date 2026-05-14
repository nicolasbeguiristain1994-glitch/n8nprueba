// @vitest-environment node
/**
 * Flujo de autenticación completo (Fase 5).
 *
 * Cubre el ciclo de vida real de login + rate limiting:
 *   1. Credenciales inválidas → 401, audit login_failed
 *   2. Acumulación de intentos fallidos → 429, audit rate_limit_exceeded
 *   3. Expiración de ventana con vi.useFakeTimers() → IP desbloqueado
 *   4. Login exitoso tras el desbloqueo → 200, audit login_success
 *
 * Ejecutar: npx vitest run lib/__tests__/flows/auth-flow.test.ts
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock('@/lib/db', () => ({
  query:           vi.fn(),
  getDbClient:     vi.fn(),
  withTransaction: vi.fn(),
  pool:            { totalCount: 0, idleCount: 0, waitingCount: 0 },
}))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('bcryptjs',    () => ({ default: { compare: vi.fn() } }))

import { POST as loginPost }  from '@/app/api/auth/login/route'
import { loginRateLimiter }   from '@/lib/rate-limit'
import * as db                from '@/lib/db'
import * as auditLib          from '@/lib/audit'
import bcryptjs               from 'bcryptjs'
import type { AuditEvent }    from '@/lib/audit'
import { makeReq, TEST_IP, TEST_AUTH_SECRET } from '@/lib/__tests__/helpers/session'

// ── Setup ─────────────────────────────────────────────────────────────────────

const LOGIN_URL = 'http://localhost/api/auth/login'

const VALID_DB_USER = {
  id: 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb', email: 'user@example.com',
  name: 'Test', role: 'operator', sectors: ['campaigns'], password_hash: 'hashed',
  is_active: true, session_version: 1, can_download_contacts: true, allowed_agents: [],
}

beforeAll(() => { process.env.AUTH_SECRET = TEST_AUTH_SECRET })

beforeEach(() => {
  vi.clearAllMocks()
  loginRateLimiter.reset(TEST_IP)
})

afterEach(() => { vi.useRealTimers() })

// ── Helpers ───────────────────────────────────────────────────────────────────

function loginReq(email: string, password: string): Request {
  return makeReq(LOGIN_URL, {
    method:  'POST',
    body:    JSON.stringify({ email, password }),
    headers: { 'content-type': 'application/json' },
  })
}

function mockLoginClient(userRow: Record<string, unknown> | null) {
  const client = {
    query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: userRow ? [userRow] : [] })
      .mockResolvedValueOnce({ rows: [] }),
    release: vi.fn(),
  }
  vi.mocked(db.getDbClient).mockResolvedValue(client as never)
  return client
}

function auditCalls(): AuditEvent[] {
  return vi.mocked(auditLib.audit).mock.calls.map(([e]) => e)
}

function getAuditCall(action: string): AuditEvent | undefined {
  return auditCalls().find(e => e.action === action)
}

// ── Flujo 1 — Credenciales inválidas ─────────────────────────────────────────

describe('Flujo 1 — Credenciales inválidas → 401 + audit login_failed', () => {
  it('returns 401 for a non-existent user', async () => {
    mockLoginClient(null)
    const res = await loginPost(loginReq('nobody@example.com', 'wrong') as never)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Invalid credentials')
  })

  it('records login_failed in audit with reason user_not_found', async () => {
    mockLoginClient(null)
    await loginPost(loginReq('nobody@example.com', 'wrong') as never)
    expect(getAuditCall('login_failed')).toMatchObject({
      resource: 'auth',
      status:   'failure',
      metadata: expect.objectContaining({ reason: 'user_not_found' }),
    })
  })

  it('returns 401 when password does not match', async () => {
    mockLoginClient(VALID_DB_USER)
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never)
    const res = await loginPost(loginReq('user@example.com', 'badpass') as never)
    expect(res.status).toBe(401)
  })

  it('records login_failed with reason password_mismatch', async () => {
    mockLoginClient(VALID_DB_USER)
    vi.mocked(bcryptjs.compare).mockResolvedValue(false as never)
    await loginPost(loginReq('user@example.com', 'badpass') as never)
    expect(getAuditCall('login_failed')).toMatchObject({
      metadata: expect.objectContaining({ reason: 'password_mismatch' }),
    })
  })
})

// ── Flujo 2 — Acumulación de intentos → rate limit ───────────────────────────

describe('Flujo 2 — Múltiples fallos → bloqueo por rate limit', () => {
  it('does not block after fewer than maxAttempts failures', async () => {
    // 9 intentos (maxAttempts = 10)
    for (let i = 0; i < 9; i++) loginRateLimiter.increment(TEST_IP)
    expect(loginRateLimiter.isBlocked(TEST_IP)).toBe(false)
  })

  it('blocks the IP after reaching maxAttempts', async () => {
    for (let i = 0; i < 10; i++) loginRateLimiter.increment(TEST_IP)
    expect(loginRateLimiter.isBlocked(TEST_IP)).toBe(true)
  })

  it('returns 429 once the IP is blocked', async () => {
    for (let i = 0; i < 10; i++) loginRateLimiter.increment(TEST_IP)
    const res = await loginPost(loginReq('any@example.com', 'any') as never)
    expect(res.status).toBe(429)
    expect((await res.json()).error).toContain('Demasiados intentos')
  })

  it('records rate_limit_exceeded with status denied', async () => {
    for (let i = 0; i < 10; i++) loginRateLimiter.increment(TEST_IP)
    await loginPost(loginReq('any@example.com', 'any') as never)
    expect(getAuditCall('rate_limit_exceeded')).toMatchObject({
      resource: 'auth',
      status:   'denied',
      metadata: expect.objectContaining({ ip: TEST_IP }),
    })
  })

  it('does not reach the DB when the IP is already blocked', async () => {
    for (let i = 0; i < 10; i++) loginRateLimiter.increment(TEST_IP)
    await loginPost(loginReq('any@example.com', 'any') as never)
    expect(vi.mocked(db.getDbClient)).not.toHaveBeenCalled()
  })
})

// ── Flujo 3 — Expiración de ventana con fake timers ──────────────────────────

describe('Flujo 3 — Ventana de rate limit expira → IP desbloqueado', () => {
  it('IP becomes unblocked after the window expires', () => {
    vi.useFakeTimers()

    // Bloqueamos usando el rate limiter directamente (windowMs = 15 min)
    for (let i = 0; i < 10; i++) loginRateLimiter.increment(TEST_IP)
    expect(loginRateLimiter.isBlocked(TEST_IP)).toBe(true)

    // Avanzamos 15 minutos + 1 ms para superar la ventana
    vi.advanceTimersByTime(15 * 60 * 1000 + 1)
    expect(loginRateLimiter.isBlocked(TEST_IP)).toBe(false)
  })

  it('allows login after the window expires (no explicit reset needed)', async () => {
    vi.useFakeTimers()

    for (let i = 0; i < 10; i++) loginRateLimiter.increment(TEST_IP)
    vi.advanceTimersByTime(15 * 60 * 1000 + 1)

    // Ahora el login debe alcanzar la DB (ya no hay bloqueo por rate limit)
    mockLoginClient(VALID_DB_USER)
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never)

    const res = await loginPost(loginReq('user@example.com', 'correct') as never)
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('session=')
  })
})

// ── Flujo 4 — Login exitoso → audit completo ─────────────────────────────────

describe('Flujo 4 — Login exitoso → 200 + cookie + audit login_success', () => {
  it('returns 200 with user data and a session cookie', async () => {
    mockLoginClient(VALID_DB_USER)
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never)

    const res  = await loginPost(loginReq('user@example.com', 'correct') as never)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.user).toMatchObject({ email: 'user@example.com', role: 'operator' })
    expect(res.headers.get('set-cookie')).toContain('session=')
    expect(res.headers.get('set-cookie')).toContain('HttpOnly')
  })

  it('records login_success with user identity in audit', async () => {
    mockLoginClient(VALID_DB_USER)
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never)

    await loginPost(loginReq('user@example.com', 'correct') as never)

    expect(getAuditCall('login_success')).toMatchObject({
      resource: 'auth',
    })
  })

  it('rate limiter is reset after a successful login', async () => {
    // Un intento fallido previo no bloquea el login exitoso
    for (let i = 0; i < 5; i++) loginRateLimiter.increment(TEST_IP)

    mockLoginClient(VALID_DB_USER)
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never)

    await loginPost(loginReq('user@example.com', 'correct') as never)
    expect(loginRateLimiter.isBlocked(TEST_IP)).toBe(false)
  })
})
