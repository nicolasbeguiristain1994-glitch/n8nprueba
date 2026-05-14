// @vitest-environment node
/**
 * Flujo E2E 2 — Autenticación y control de acceso RBAC completo.
 *
 * Cubre escenarios de autenticación/autorización no presentes en resource-flow.test.ts:
 *
 *   1. Sin sesión (sin cookie) → 401 Unauthorized, sin consulta a la DB
 *   2. Session stale (session_version en cookie < DB) → 401 Session expired
 *   3. Usuario desactivado en DB (is_active=false) → 401 aunque la cookie sea válida
 *   4. Operator con sector incorrecto → 403 Forbidden
 *   5. Viewer con sector correcto → 200 (solo lectura permitida)
 *   6. Operator con sector correcto → 200
 *   7. Admin → 200 sin importar sectores
 *
 *   Para cada caso de rechazo se verifica también el evento emitido por securityLog.
 *
 * Ruta usada como sujeto de prueba: GET /api/templates (requiere campaigns/read).
 *
 * Ejecutar: npx vitest run lib/__tests__/e2e/permissions-rbac.test.ts
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock('@/lib/db', () => ({
  query:           vi.fn(),
  getDbClient:     vi.fn(),
  withTransaction: vi.fn(),
  pool:            { totalCount: 0, idleCount: 0, waitingCount: 0 },
}))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))

import { GET as templatesGet } from '@/app/api/templates/route'
import { NextRequest }          from 'next/server'
import * as db                  from '@/lib/db'
import { createSessionToken }   from '@/lib/auth'
import type { SessionUser }     from '@/lib/auth'
import {
  makeSession,
  makeAdminSession,
  makeOperatorSession,
  makeViewerSession,
  captureStdout,
  TEST_IP,
  TEST_AUTH_SECRET,
} from '@/lib/__tests__/helpers/session'

// ── Constants ─────────────────────────────────────────────────────────────────

const TEMPLATES_URL = 'http://localhost/api/templates'

// ── Request builder ───────────────────────────────────────────────────────────

/** GET request with optional session cookie and test IP. */
function getReq(session?: SessionUser): NextRequest {
  const headers: Record<string, string> = { 'x-forwarded-for': TEST_IP }
  if (session) headers.cookie = `session=${createSessionToken(session)}`
  return new NextRequest(TEMPLATES_URL, { headers })
}

// ── DB mock helpers ───────────────────────────────────────────────────────────

type DbUserRow = {
  role: string; sectors: string[]; is_active: boolean
  session_version: number; can_download_contacts: boolean; allowed_agents: string[]
}

/** Mock the RBAC permission check (first db.query in checkPermissionWithUser). */
function mockPermissionCheck(override: Partial<DbUserRow> = {}): void {
  vi.mocked(db.query).mockResolvedValueOnce([{
    role: 'operator', sectors: [], is_active: true,
    session_version: 1, can_download_contacts: true, allowed_agents: [],
    ...override,
  }] as never)
}

/** Mock the templates SELECT that follows a successful permission check. */
function mockEmptyTemplates(): void {
  vi.mocked(db.query).mockResolvedValueOnce([] as never)
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(() => { process.env.AUTH_SECRET = TEST_AUTH_SECRET })
beforeEach(() => { vi.resetAllMocks() })

// ── Flujo 1 — Sin sesión ──────────────────────────────────────────────────────

describe('Flujo E2E 2.1 — Sin sesión (sin cookie)', () => {
  it('devuelve 401 Unauthorized cuando no hay cookie de sesión', async () => {
    const res = await templatesGet(getReq()) // no session passed
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Unauthorized')
  })

  it('no consulta la DB cuando no hay sesión (short-circuit antes del DB check)', async () => {
    await templatesGet(getReq())
    expect(vi.mocked(db.query)).not.toHaveBeenCalled()
  })

  it('emite session_invalid con reason=no_session a stdout', async () => {
    const { events } = await captureStdout(() => templatesGet(getReq()))
    expect(
      events.some(e => e.event === 'session_invalid' && e.reason === 'no_session')
    ).toBe(true)
  })
})

// ── Flujo 2 — Session stale (session_version mismatch) ───────────────────────

describe('Flujo E2E 2.2 — Session stale: session_version no coincide con DB', () => {
  it('devuelve 401 Session expired cuando el session_version es diferente al de la DB', async () => {
    // Cookie has version 1, DB returns version 2
    const session = makeOperatorSession(['campaigns'], { session_version: 1 })
    mockPermissionCheck({ role: 'operator', sectors: ['campaigns'], session_version: 2 })

    const res = await templatesGet(getReq(session))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Session expired')
  })

  it('emite session_invalid con reason=session_version_mismatch', async () => {
    const session = makeOperatorSession(['campaigns'], { session_version: 1 })
    mockPermissionCheck({ role: 'operator', sectors: ['campaigns'], session_version: 2 })

    const { events } = await captureStdout(() => templatesGet(getReq(session)))
    expect(
      events.some(e =>
        e.event === 'session_invalid' && e.reason === 'session_version_mismatch'
      )
    ).toBe(true)
  })

  it('una cookie con session_version correcto (=DB) obtiene 200', async () => {
    // Both cookie and DB have version 1
    const session = makeOperatorSession(['campaigns'], { session_version: 1 })
    mockPermissionCheck({ role: 'operator', sectors: ['campaigns'], session_version: 1 })
    mockEmptyTemplates()

    const res = await templatesGet(getReq(session))
    expect(res.status).toBe(200)
  })
})

// ── Flujo 3 — Usuario desactivado en DB ──────────────────────────────────────

describe('Flujo E2E 2.3 — Usuario desactivado en DB con cookie válida', () => {
  it('devuelve 401 Unauthorized aunque la cookie sea válida', async () => {
    const session = makeOperatorSession(['campaigns'])
    mockPermissionCheck({ role: 'operator', sectors: ['campaigns'], is_active: false })

    const res = await templatesGet(getReq(session))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('Unauthorized')
  })

  it('emite session_invalid con reason=user_not_found_or_inactive', async () => {
    const session = makeOperatorSession(['campaigns'])
    mockPermissionCheck({ role: 'operator', sectors: ['campaigns'], is_active: false })

    const { events } = await captureStdout(() => templatesGet(getReq(session)))
    expect(
      events.some(e =>
        e.event === 'session_invalid' && e.reason === 'user_not_found_or_inactive'
      )
    ).toBe(true)
  })
})

// ── Flujo 4 — Operator con sector incorrecto ──────────────────────────────────

describe('Flujo E2E 2.4 — Operator con sector incorrecto', () => {
  it('devuelve 403 Forbidden cuando el operator no tiene el sector requerido', async () => {
    const session = makeOperatorSession(['contacts', 'warmup'])
    mockPermissionCheck({ role: 'operator', sectors: ['contacts', 'warmup'] })

    const res = await templatesGet(getReq(session))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Forbidden')
  })

  it('emite access_denied con resource=campaigns a stdout (el handler chequea campaigns/read)', async () => {
    const session = makeOperatorSession(['contacts'])
    mockPermissionCheck({ role: 'operator', sectors: ['contacts'] })

    const { events } = await captureStdout(() => templatesGet(getReq(session)))
    expect(
      events.some(e => e.event === 'access_denied' && e.resource === 'campaigns')
    ).toBe(true)
  })

  it('NO emite access_denied si el sector está presente (solo 403 lo dispara)', async () => {
    const session = makeOperatorSession(['campaigns'])
    mockPermissionCheck({ role: 'operator', sectors: ['campaigns'] })
    mockEmptyTemplates()

    const { events } = await captureStdout(() => templatesGet(getReq(session)))
    expect(events.some(e => e.event === 'access_denied')).toBe(false)
  })
})

// ── Flujo 5 — Viewer con sector correcto ─────────────────────────────────────

describe('Flujo E2E 2.5 — Viewer con sector correcto (solo lectura)', () => {
  it('devuelve 200 para un viewer con el sector campaigns asignado', async () => {
    const session = makeViewerSession({ sectors: ['campaigns'] })
    mockPermissionCheck({ role: 'viewer', sectors: ['campaigns'] })
    mockEmptyTemplates()

    const res = await templatesGet(getReq(session))
    expect(res.status).toBe(200)
    expect(Array.isArray((await res.json()).templates)).toBe(true)
  })
})

// ── Flujo 6 — Operator con sector correcto ────────────────────────────────────

describe('Flujo E2E 2.6 — Operator con sector correcto', () => {
  it('devuelve 200 cuando el operator tiene el sector campaigns', async () => {
    const session = makeOperatorSession(['campaigns'])
    mockPermissionCheck({ role: 'operator', sectors: ['campaigns'] })
    mockEmptyTemplates()

    const res = await templatesGet(getReq(session))
    expect(res.status).toBe(200)
    expect(Array.isArray((await res.json()).templates)).toBe(true)
  })
})

// ── Flujo 7 — Admin bypasa todo check de sector ──────────────────────────────

describe('Flujo E2E 2.7 — Admin (bypasa sector checks)', () => {
  it('devuelve 200 aunque el admin no tenga sectores asignados', async () => {
    const session = makeAdminSession({ sectors: [] })
    mockPermissionCheck({ role: 'admin', sectors: [] })
    mockEmptyTemplates()

    const res = await templatesGet(getReq(session))
    expect(res.status).toBe(200)
  })

  it('devuelve 200 incluso con un sector completamente diferente al recurso', async () => {
    const session = makeAdminSession({ sectors: ['warmup'] })
    mockPermissionCheck({ role: 'admin', sectors: ['warmup'] })
    mockEmptyTemplates()

    const res = await templatesGet(getReq(session))
    expect(res.status).toBe(200)
  })
})

// ── Cross-cutting: secuencia completa del flujo 2 ────────────────────────────

describe('Flujo E2E 2.8 — Secuencia completa: mismo usuario, sesión renovada', () => {
  it('sesión expirada (version=1) → falla; nueva sesión (version=2) → pasa', async () => {
    const staleSession = makeOperatorSession(['campaigns'], { session_version: 1 })
    const freshSession = makeOperatorSession(['campaigns'], { session_version: 2 })

    // Stale session → 401
    mockPermissionCheck({ role: 'operator', sectors: ['campaigns'], session_version: 2 })
    const res1 = await templatesGet(getReq(staleSession))
    expect(res1.status).toBe(401)

    // Fresh session with matching version → 200
    vi.resetAllMocks()
    mockPermissionCheck({ role: 'operator', sectors: ['campaigns'], session_version: 2 })
    mockEmptyTemplates()
    const res2 = await templatesGet(getReq(freshSession))
    expect(res2.status).toBe(200)
  })
})
