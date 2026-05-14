// @vitest-environment node
/**
 * Flujo E2E 1 — Rate limiting conducido por requests HTTP reales.
 *
 * A diferencia de auth-flow.test.ts (que incrementa el contador directamente),
 * este test conduce el flujo completo: cada intento de login pasa por el route
 * handler real, que llama al rate limiter, consulta la DB y retorna la respuesta HTTP.
 *
 * Cubre:
 *   1. 10 requests fallidos reales → el 11° devuelve 429 automáticamente
 *   2. Bloqueo acotado por IP — bloquear TEST_IP no afecta a una IP diferente
 *   3. Ventana de 15 min expira con fake timers → IP puede volver a intentar
 *   4. securityLog emite `rate_limit_exceeded` a stdout cuando el IP está bloqueado
 *   5. securityLog NO emite rate_limit_exceeded antes de alcanzar el límite
 *
 * Ejecutar: npx vitest run lib/__tests__/e2e/login-ratelimit.test.ts
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

import { POST as loginPost } from '@/app/api/auth/login/route'
import { loginRateLimiter }  from '@/lib/rate-limit'
import * as db               from '@/lib/db'
import {
  TEST_IP, TEST_AUTH_SECRET, captureStdout,
} from '@/lib/__tests__/helpers/session'

// ── Constants ─────────────────────────────────────────────────────────────────

const LOGIN_URL = 'http://localhost/api/auth/login'
const ALT_IP    = '10.0.0.99'

// ── Helpers ───────────────────────────────────────────────────────────────────

function loginReq(ip = TEST_IP): Request {
  return new Request(LOGIN_URL, {
    method:  'POST',
    body:    JSON.stringify({ email: 'nobody@test.com', password: 'wrong' }),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  })
}

/**
 * Configure getDbClient so every call returns a fresh client that simulates
 * a non-empty users table with no matching user ("user not found" → 401).
 * Each call produces a new object so each request has independent query state.
 */
function mockUserNotFound(): void {
  vi.mocked(db.getDbClient).mockImplementation(async () => ({
    query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // table has rows (not bootstrap)
      .mockResolvedValueOnce({ rows: [] }),                // no user found → 401
    release: vi.fn(),
  } as never))
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(() => { process.env.AUTH_SECRET = TEST_AUTH_SECRET })

beforeEach(() => {
  vi.resetAllMocks()
  loginRateLimiter.reset(TEST_IP)
  loginRateLimiter.reset(ALT_IP)
  mockUserNotFound()
})

afterEach(() => { vi.useRealTimers() })

// ── Flujo 1 — Acumulación de intentos fallidos ────────────────────────────────

describe('Flujo E2E 1.1 — Acumulación de intentos fallidos', () => {
  it('los primeros 10 requests fallidos devuelven 401 (sin bloqueo aún)', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await loginPost(loginReq() as never)
      expect(res.status).toBe(401)
    }
  })

  it('el request #11 devuelve 429 tras 10 fallos previos', async () => {
    for (let i = 0; i < 10; i++) await loginPost(loginReq() as never)

    const res = await loginPost(loginReq() as never)
    expect(res.status).toBe(429)
    expect((await res.json()).error).toContain('Demasiados intentos')
  })

  it('una vez bloqueado la DB no se consulta (short-circuit)', async () => {
    for (let i = 0; i < 10; i++) await loginPost(loginReq() as never)

    vi.mocked(db.getDbClient).mockClear()
    await loginPost(loginReq() as never)

    expect(vi.mocked(db.getDbClient)).not.toHaveBeenCalled()
  })
})

// ── Flujo 2 — Aislamiento por IP ─────────────────────────────────────────────

describe('Flujo E2E 1.2 — Bloqueo acotado por IP', () => {
  it('bloquear TEST_IP no afecta a una IP diferente', async () => {
    for (let i = 0; i < 10; i++) await loginPost(loginReq(TEST_IP) as never)

    // ALT_IP not yet blocked — should get 401, not 429
    const res = await loginPost(loginReq(ALT_IP) as never)
    expect(res.status).toBe(401)
  })

  it('TEST_IP devuelve 429 mientras ALT_IP devuelve 401 en el mismo instante', async () => {
    for (let i = 0; i < 10; i++) await loginPost(loginReq(TEST_IP) as never)

    const [blocked, free] = await Promise.all([
      loginPost(loginReq(TEST_IP) as never),
      loginPost(loginReq(ALT_IP) as never),
    ])
    expect(blocked.status).toBe(429)
    expect(free.status).toBe(401)
  })
})

// ── Flujo 3 — Expiración de ventana con fake timers ──────────────────────────

describe('Flujo E2E 1.3 — Expiración de la ventana de 15 minutos', () => {
  it('después de que la ventana expira el IP puede volver a intentar login', async () => {
    vi.useFakeTimers()

    // Saturate the rate limiter with 10 real failing requests
    for (let i = 0; i < 10; i++) await loginPost(loginReq() as never)
    expect((await loginPost(loginReq() as never)).status).toBe(429)

    // Advance past the 15-minute window
    vi.advanceTimersByTime(15 * 60 * 1000 + 1)

    // IP is no longer blocked — reaches the DB and gets 401 (not 429)
    const res = await loginPost(loginReq() as never)
    expect(res.status).toBe(401)
  })
})

// ── Flujo 4 — Eventos de seguridad en stdout ──────────────────────────────────

describe('Flujo E2E 1.4 — securityLog emitido a stdout', () => {
  it('emite rate_limit_exceeded con la IP bloqueada cuando se devuelve 429', async () => {
    for (let i = 0; i < 10; i++) await loginPost(loginReq() as never)

    const { result, events } = await captureStdout(() =>
      loginPost(loginReq() as never)
    )

    expect(result.status).toBe(429)
    expect(
      events.some(e => e.event === 'rate_limit_exceeded' && e.ip === TEST_IP)
    ).toBe(true)
  })

  it('NO emite rate_limit_exceeded durante los intentos previos al límite', async () => {
    const { events } = await captureStdout(async () => {
      for (let i = 0; i < 5; i++) await loginPost(loginReq() as never)
    })

    expect(events.some(e => e.event === 'rate_limit_exceeded')).toBe(false)
  })

  it('el evento tiene level SECURITY', async () => {
    for (let i = 0; i < 10; i++) await loginPost(loginReq() as never)

    const { events } = await captureStdout(() => loginPost(loginReq() as never))
    const evt = events.find(e => e.event === 'rate_limit_exceeded')

    expect(evt?.level).toBe('SECURITY')
  })
})
