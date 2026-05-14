// @vitest-environment node
/**
 * Tests de integración de seguridad.
 * Cubre flujos completos: login + rate limiting, RBAC en rutas,
 * auditoría al crear recursos, y validación de input en rutas protegidas.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

// ── Mocks (hoisted before all imports) ───────────────────────────────────────
vi.mock('@/lib/db', () => ({
  query:           vi.fn(),
  getDbClient:     vi.fn(),
  withTransaction: vi.fn(),
  pool:            { totalCount: 0, idleCount: 0, waitingCount: 0 },
}))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('bcryptjs',    () => ({ default: { compare: vi.fn() } }))

import { POST as loginPost }     from '@/app/api/auth/login/route'
import { POST as templatesPost } from '@/app/api/templates/route'
import { loginRateLimiter }      from '@/lib/rate-limit'
import * as db                   from '@/lib/db'
import * as auditLib             from '@/lib/audit'
import bcryptjs                  from 'bcryptjs'
import { makeSession, makeReqWithSession, makeReq, TEST_IP, TEST_AUTH_SECRET }
  from '@/lib/__tests__/helpers/session'

// ── Global setup ──────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.AUTH_SECRET = TEST_AUTH_SECRET
})

beforeEach(() => {
  vi.clearAllMocks()
  loginRateLimiter.reset(TEST_IP)
})

afterEach(() => {
  vi.useRealTimers()
})

// ── DB mock factories ─────────────────────────────────────────────────────────

type DbUserRow = { role: 'admin' | 'operator' | 'viewer'; sectors: string[]; is_active: boolean; session_version: number }

/** Mock db.query (used by checkPermissionWithUser and route INSERT calls). */
function mockDbQuery(...rows: unknown[][]) {
  let mock = vi.mocked(db.query)
  for (const row of rows) mock = mock.mockResolvedValueOnce(row) as typeof mock
}

/**
 * Mock the pg PoolClient returned by getDbClient (used by the login route).
 * Supports up to 3 sequential calls: COUNT(*), SELECT user, UPDATE last_login_at.
 */
function mockLoginClient(opts: { userCount?: number; userRow?: Record<string, unknown> | null } = {}) {
  const { userCount = 1, userRow = null } = opts
  const client = {
    query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ count: String(userCount) }] })
      .mockResolvedValueOnce({ rows: userRow ? [userRow] : [] })
      .mockResolvedValueOnce({ rows: [] }),
    release: vi.fn(),
  }
  vi.mocked(db.getDbClient).mockResolvedValue(client as never)
  return client
}

// ── Audit helpers ─────────────────────────────────────────────────────────────

import type { AuditEvent } from '@/lib/audit'

/** Returns all audit events recorded so far in the current test. */
function auditCalls(): AuditEvent[] {
  return vi.mocked(auditLib.audit).mock.calls.map(([e]) => e)
}

/** Returns the first audit event matching the given action, or undefined. */
function getAuditCall(action: string): AuditEvent | undefined {
  return auditCalls().find(e => e.action === action)
}

// ── Flujo 1 — Login + Rate Limiting ──────────────────────────────────────────

describe('Flujo 1 — Login + Rate Limiting', () => {
  const LOGIN_URL = 'http://localhost/api/auth/login'

  function loginReq(email: string, password: string): Request {
    return makeReq(LOGIN_URL, {
      method:  'POST',
      body:    JSON.stringify({ email, password }),
      headers: { 'content-type': 'application/json' },
    })
  }

  it('returns 401 when the user does not exist in the database', async () => {
    mockLoginClient({ userRow: null })

    const res  = await loginPost(loginReq('ghost@example.com', 'wrong') as never)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid credentials')
  })

  it('returns 200 and a session cookie on valid credentials', async () => {
    const dbUser = {
      id: 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb', email: 'admin@example.com',
      name: 'Admin', role: 'admin', sectors: [], password_hash: 'hashed',
      is_active: true, session_version: 1, can_download_contacts: true, allowed_agents: [],
    }
    mockLoginClient({ userRow: dbUser })
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never)

    const res  = await loginPost(loginReq('admin@example.com', 'correct-pass') as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.user.role).toBe('admin')
    expect(res.headers.get('set-cookie')).toContain('session=')
  })

  it('audit records login_success on valid login', async () => {
    const dbUser = {
      id: 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb', email: 'admin@example.com',
      name: 'Admin', role: 'admin', sectors: [], password_hash: 'hashed',
      is_active: true, session_version: 1, can_download_contacts: true, allowed_agents: [],
    }
    mockLoginClient({ userRow: dbUser })
    vi.mocked(bcryptjs.compare).mockResolvedValue(true as never)

    await loginPost(loginReq('admin@example.com', 'correct') as never)

    expect(vi.mocked(auditLib.audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'login_success', resource: 'auth' })
    )
  })

  it('returns 429 when the IP has exceeded the rate limit', async () => {
    for (let i = 0; i < 10; i++) loginRateLimiter.increment(TEST_IP)

    const res  = await loginPost(loginReq('any@example.com', 'any') as never)
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toContain('Demasiados intentos')
  })

  it('audit records rate_limit_exceeded when IP is blocked', async () => {
    for (let i = 0; i < 10; i++) loginRateLimiter.increment(TEST_IP)

    await loginPost(loginReq('any@example.com', 'any') as never)

    expect(getAuditCall('rate_limit_exceeded')).toMatchObject({ resource: 'auth', status: 'denied' })
  })

  it('IP is unblocked after loginRateLimiter.reset()', () => {
    for (let i = 0; i < 10; i++) loginRateLimiter.increment(TEST_IP)
    expect(loginRateLimiter.isBlocked(TEST_IP)).toBe(true)

    loginRateLimiter.reset(TEST_IP)
    expect(loginRateLimiter.isBlocked(TEST_IP)).toBe(false)
  })
})

// ── Flujo 2 — RBAC en rutas ───────────────────────────────────────────────────

describe('Flujo 2 — RBAC en rutas (POST /api/templates)', () => {
  const TEMPLATES_URL = 'http://localhost/api/templates'

  const VALID_BODY = JSON.stringify({
    name:       'test_template',
    category:   'UTILITY',
    components: [{ type: 'BODY', text: 'Hello' }],
  })

  it('returns 401 when no session cookie is present', async () => {
    const req = new Request(TEMPLATES_URL, { method: 'POST', body: VALID_BODY })
    const res = await templatesPost(req as never)
    expect(res.status).toBe(401)
  })

  it('returns 401 when the session token has been tampered', async () => {
    const req = new Request(TEMPLATES_URL, {
      method:  'POST',
      body:    VALID_BODY,
      headers: { cookie: 'session=tampered.payload.invalidsig' },
    })
    const res = await templatesPost(req as never)
    expect(res.status).toBe(401)
  })

  it('returns 403 when a viewer tries to create a template', async () => {
    const viewer = makeSession({ role: 'viewer', sectors: ['settings'] })
    mockDbQuery([{ role: 'viewer', sectors: ['settings'], is_active: true, session_version: 1 }])

    const req = makeReqWithSession(TEMPLATES_URL, viewer, {
      method:  'POST',
      body:    VALID_BODY,
      headers: { 'content-type': 'application/json' },
    })
    const res = await templatesPost(req as never)
    expect(res.status).toBe(403)
  })

  it('returns 403 when an operator has a valid session but wrong sector', async () => {
    // operators need 'settings' sector for manage; 'campaigns' sector is not enough
    const operator = makeSession({ role: 'operator', sectors: ['campaigns'] })
    mockDbQuery([{ role: 'operator', sectors: ['campaigns'], is_active: true, session_version: 1 }])

    const req = makeReqWithSession(TEMPLATES_URL, operator, {
      method:  'POST',
      body:    VALID_BODY,
      headers: { 'content-type': 'application/json' },
    })
    const res = await templatesPost(req as never)
    expect(res.status).toBe(403)
  })

  it('returns 201 when an admin creates a valid template', async () => {
    const admin = makeSession({ role: 'admin', sectors: [] })
    const newId = 'cccccccc-0000-0000-0000-cccccccccccc'
    mockDbQuery(
      [{ role: 'admin', sectors: [], is_active: true, session_version: 1 }], // RBAC check
      [{ id: newId }],                                                         // INSERT RETURNING
    )

    const req = makeReqWithSession(TEMPLATES_URL, admin, {
      method:  'POST',
      body:    VALID_BODY,
      headers: { 'content-type': 'application/json' },
    })
    const res  = await templatesPost(req as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toBe(newId)
  })
})

// ── Flujo 3 — Creación + Auditoría ───────────────────────────────────────────

describe('Flujo 3 — Auditoría al crear un recurso', () => {
  const TEMPLATES_URL = 'http://localhost/api/templates'

  function adminCreateReq(name: string, category = 'UTILITY'): Request {
    const admin = makeSession({ role: 'admin', sectors: [] })
    return makeReqWithSession(TEMPLATES_URL, admin, {
      method:  'POST',
      body:    JSON.stringify({ name, category, components: [{ type: 'BODY', text: 'Hi' }] }),
      headers: { 'content-type': 'application/json' },
    })
  }

  it('audit is called with action:create and resource:templates on success', async () => {
    const newId = 'dddddddd-0000-0000-0000-dddddddddddd'
    mockDbQuery(
      [{ role: 'admin', sectors: [], is_active: true, session_version: 1 }],
      [{ id: newId }],
    )

    await templatesPost(adminCreateReq('audit_test') as never)

    expect(vi.mocked(auditLib.audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'create', resource: 'templates', resource_id: newId })
    )
  })

  it('audit resource_id matches the id returned by the INSERT', async () => {
    const newId = 'eeeeeeee-0000-0000-0000-eeeeeeeeeeee'
    mockDbQuery(
      [{ role: 'admin', sectors: [], is_active: true, session_version: 1 }],
      [{ id: newId }],
    )

    await templatesPost(adminCreateReq('id_check', 'MARKETING') as never)

    expect(getAuditCall('create')?.resource_id).toBe(newId)
  })

  it('action:create is NOT fired when permission is denied', async () => {
    const viewer = makeSession({ role: 'viewer', sectors: [] })
    mockDbQuery([{ role: 'viewer', sectors: [], is_active: true, session_version: 1 }])

    const req = makeReqWithSession(TEMPLATES_URL, viewer, {
      method:  'POST',
      body:    JSON.stringify({ name: 'x', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi' }] }),
      headers: { 'content-type': 'application/json' },
    })
    await templatesPost(req as never)

    expect(auditCalls().map(e => e.action)).not.toContain('create')
  })
})

// ── Flujo 4 — Validación de input ─────────────────────────────────────────────

describe('Flujo 4 — Validación de input en rutas protegidas', () => {
  const TEMPLATES_URL = 'http://localhost/api/templates'

  /** Creates an admin request past the RBAC gate, with the given payload. */
  function adminReq(payload: unknown): Request {
    const admin = makeSession({ role: 'admin', sectors: [] })
    mockDbQuery([{ role: 'admin', sectors: [], is_active: true, session_version: 1 }])
    return makeReqWithSession(TEMPLATES_URL, admin, {
      method:  'POST',
      body:    JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    })
  }

  it('returns 400 for an invalid category enum value', async () => {
    const res  = await templatesPost(adminReq({ name: 'x', category: 'WRONG' }) as never)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Validation failed')
    expect(Array.isArray(body.issues)).toBe(true)
    expect(body.issues.length).toBeGreaterThan(0)
  })

  it('returns 400 and reports the missing name field in issues', async () => {
    const res  = await templatesPost(adminReq({ category: 'UTILITY' }) as never)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.issues.some((i: { path: string }) => i.path === 'name')).toBe(true)
  })

  it('each issue in the 400 response has a string path and a string message', async () => {
    const res  = await templatesPost(adminReq({}) as never)
    expect(res.status).toBe(400)
    const body = await res.json()
    for (const issue of body.issues) {
      expect(typeof issue.path).toBe('string')
      expect(typeof issue.message).toBe('string')
    }
  })
})
