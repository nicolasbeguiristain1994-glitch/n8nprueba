// @vitest-environment node
/**
 * Flujos completos de recursos — RBAC, creación y actualización (Fase 5).
 *
 * Flujo 1 — RBAC journey: sector check con GET /api/templates (campaigns/read).
 *           Operators necesitan sector 'campaigns'; admins siempre pasan.
 * Flujo 2 — Create journey: payload inválido → 400; corregido → 201 + audit.
 * Flujo 3 — Update journey: PATCH parcial → audit.fields exacto; campos omitidos ausentes.
 *
 * Nota de diseño: POST/PATCH de templates requieren settings/manage (admin-only).
 *   GET de templates requiere campaigns/read (operators con ese sector pueden acceder).
 *   Por eso Flujo 1 usa GET para testear el sector check con operators.
 *
 * Ejecutar: npx vitest run lib/__tests__/flows/resource-flow.test.ts
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

import { GET   as templatesGet  } from '@/app/api/templates/route'
import { POST  as templatesPost } from '@/app/api/templates/route'
import { PATCH as templatesPatch } from '@/app/api/templates/[id]/route'
import { NextRequest }             from 'next/server'
import * as db                     from '@/lib/db'
import * as auditLib               from '@/lib/audit'
import type { AuditEvent }         from '@/lib/audit'
import {
  makeAdminSession, makeOperatorSession,
  makeReqWithSession, adminPost, adminPatch,
  TEST_IP, TEST_AUTH_SECRET,
} from '@/lib/__tests__/helpers/session'
import { createSessionToken } from '@/lib/auth'
import type { SessionUser }   from '@/lib/auth'

// ── Setup ─────────────────────────────────────────────────────────────────────

const TEMPLATES_URL = 'http://localhost/api/templates'
const TEMPLATE_ID   = 'ffffffff-0000-0000-0000-ffffffffffff'
const TEMPLATE_URL  = `${TEMPLATES_URL}/${TEMPLATE_ID}`

beforeAll(() => { process.env.AUTH_SECRET = TEST_AUTH_SECRET })

// resetAllMocks limpia tanto el historial de llamadas como la cola de mockResolvedValueOnce,
// evitando que mocks no consumidos de un test contaminen el siguiente.
beforeEach(() => { vi.resetAllMocks() })

// ── DB mock factory ───────────────────────────────────────────────────────────

function mockDbQuery(...rows: unknown[][]) {
  let mock = vi.mocked(db.query)
  for (const row of rows) mock = mock.mockResolvedValueOnce(row) as typeof mock
}

function dbAdminRow() {
  return { role: 'admin', sectors: [], is_active: true, session_version: 1 }
}

function dbOperatorRow(sectors: string[]) {
  return { role: 'operator', sectors, is_active: true, session_version: 1 }
}

// ── Audit helpers ─────────────────────────────────────────────────────────────

function auditCalls(): AuditEvent[] {
  return vi.mocked(auditLib.audit).mock.calls.map(([e]) => e)
}

function getAuditCall(action: string): AuditEvent | undefined {
  return auditCalls().find(e => e.action === action)
}

// ── Request builders ──────────────────────────────────────────────────────────

// GET usa NextRequest porque el handler accede a req.nextUrl.searchParams.
function makeGetReq(session: SessionUser): NextRequest {
  const token = createSessionToken(session)
  return new NextRequest(TEMPLATES_URL, {
    headers: {
      cookie:            `session=${token}`,
      'x-forwarded-for': TEST_IP,
    },
  })
}

// ── Flujo 1 — RBAC Journey ────────────────────────────────────────────────────
//
// GET /api/templates requiere campaigns/read.
// Narrativa: operator sin sector → 403; mismo tipo de usuario con sector correcto → 200.

describe('Flujo 1 — RBAC journey: sector check en GET /api/templates', () => {
  it('step 1 — operator without "campaigns" sector is denied (403)', async () => {
    const operator = makeOperatorSession(['settings', 'warmup'])
    mockDbQuery([dbOperatorRow(['settings', 'warmup'])])

    const res = await templatesGet(makeGetReq(operator))
    expect(res.status).toBe(403)
  })

  it('step 1 — denial does not emit any create audit event', async () => {
    const operator = makeOperatorSession(['contacts'])
    mockDbQuery([dbOperatorRow(['contacts'])])

    await templatesGet(makeGetReq(operator))
    expect(auditCalls().map(e => e.action)).not.toContain('create')
  })

  it('step 2 — operator with "campaigns" sector can read templates (200)', async () => {
    const operator = makeOperatorSession(['campaigns'])
    mockDbQuery(
      [dbOperatorRow(['campaigns'])], // RBAC check (checkPermissionWithUser)
      [],                              // SELECT templates → empty result
    )

    const res  = await templatesGet(makeGetReq(operator))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.templates)).toBe(true)
  })

  it('step 2 — admin always passes regardless of sectors', async () => {
    const admin = makeAdminSession()
    mockDbQuery(
      [dbAdminRow()], // RBAC check
      [],              // SELECT templates
    )

    const res = await templatesGet(makeGetReq(admin))
    expect(res.status).toBe(200)
  })
})

// ── Flujo 2 — Create Journey ──────────────────────────────────────────────────
//
// POST /api/templates requiere settings/manage (admin-only).
// Narrativa: admin envía payload inválido → 400; corrige y crea → 201 + audit.

describe('Flujo 2 — Create journey: inválido → 400, corregido → 201 + audit', () => {
  it('step 1 — missing name field returns 400 with issue on "name"', async () => {
    const admin = makeAdminSession()
    mockDbQuery([dbAdminRow()])

    const res  = await templatesPost(adminPost(TEMPLATES_URL, admin, { category: 'UTILITY' }) as never)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Validation failed')
    expect(body.issues.some((i: { path: string }) => i.path === 'name')).toBe(true)
  })

  it('step 1 — invalid category enum returns 400 with issue on "category"', async () => {
    const admin = makeAdminSession()
    mockDbQuery([dbAdminRow()])

    const res  = await templatesPost(adminPost(TEMPLATES_URL, admin, { name: 'x', category: 'NOT_VALID' }) as never)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.issues.some((i: { path: string }) => i.path === 'category')).toBe(true)
  })

  it('step 1 — validation failure does not emit a create audit event', async () => {
    const admin = makeAdminSession()
    mockDbQuery([dbAdminRow()])

    await templatesPost(adminPost(TEMPLATES_URL, admin, { name: 'x', category: 'BAD' }) as never)
    expect(auditCalls().map(e => e.action)).not.toContain('create')
  })

  it('step 2 — corrected payload returns 201 with the new resource id', async () => {
    const admin = makeAdminSession()
    const newId = 'bbbbbbbb-1111-0000-0000-bbbbbbbbbbbb'
    mockDbQuery([dbAdminRow()], [{ id: newId }])

    const res = await templatesPost(adminPost(TEMPLATES_URL, admin, {
      name:       'promo_julio',
      category:   'MARKETING',
      components: [{ type: 'BODY', text: 'Hola' }],
    }) as never)

    expect(res.status).toBe(201)
    expect((await res.json()).id).toBe(newId)
  })

  it('step 2 — successful create emits audit with action, resource and resource_id', async () => {
    const admin = makeAdminSession()
    const newId = 'bbbbbbbb-2222-0000-0000-bbbbbbbbbbbb'
    mockDbQuery([dbAdminRow()], [{ id: newId }])

    await templatesPost(adminPost(TEMPLATES_URL, admin, {
      name:       'promo_agosto',
      category:   'UTILITY',
      components: [{ type: 'BODY', text: 'Info' }],
    }) as never)

    expect(getAuditCall('create')).toMatchObject({
      action:      'create',
      resource:    'templates',
      resource_id: newId,
      metadata:    expect.objectContaining({ name: 'promo_agosto', category: 'UTILITY' }),
    })
  })
})

// ── Flujo 3 — Update Journey ──────────────────────────────────────────────────
//
// PATCH /api/templates/[id] requiere settings/manage (admin-only).
// Narrativa: admin actualiza solo algunos campos; audit.fields refleja exactamente los enviados.

describe('Flujo 3 — Update journey: PATCH parcial → audit.fields exacto', () => {
  // Helper local: configura mocks y construye la request de PATCH.
  function patchReq(body: Record<string, unknown>): Request {
    const admin = makeAdminSession()
    mockDbQuery(
      [dbAdminRow()],         // RBAC check
      [{ id: TEMPLATE_ID }],  // UPDATE RETURNING id
    )
    return adminPatch(TEMPLATE_URL, admin, body)
  }

  async function callPatch(body: Record<string, unknown>) {
    return templatesPatch(
      patchReq(body) as never,
      { params: Promise.resolve({ id: TEMPLATE_ID }) },
    )
  }

  it('returns 200 when updating only the status field', async () => {
    const res = await callPatch({ status: 'APROBADA' })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('audit fields contains exactly the single updated field', async () => {
    await callPatch({ status: 'APROBADA' })
    expect(getAuditCall('update')?.metadata?.fields).toEqual(['status'])
  })

  it('audit fields lists both updated fields and excludes all omitted ones', async () => {
    await callPatch({ status: 'RECHAZADA', rejection_reason: 'Contenido no permitido' })

    const fields = getAuditCall('update')?.metadata?.fields as string[]
    expect(fields).toContain('status')
    expect(fields).toContain('rejection_reason')
    expect(fields).not.toContain('name')
    expect(fields).not.toContain('category')
    expect(fields).not.toContain('language')
  })

  it('audit uses resource:templates (not the old copy-paste "campaigns")', async () => {
    await callPatch({ status: 'APROBADA' })
    expect(getAuditCall('update')).toMatchObject({
      resource:    'templates',
      resource_id: TEMPLATE_ID,
    })
  })

  it('returns 403 when operator without settings sector tries to update', async () => {
    const operator = makeOperatorSession(['campaigns'])
    mockDbQuery([dbOperatorRow(['campaigns'])])

    const res = await templatesPatch(
      makeReqWithSession(TEMPLATE_URL, operator, {
        method:  'PATCH',
        body:    JSON.stringify({ status: 'APROBADA' }),
        headers: { 'content-type': 'application/json' },
      }) as never,
      { params: Promise.resolve({ id: TEMPLATE_ID }) },
    )
    expect(res.status).toBe(403)
  })

  it('returns 400 for an invalid status enum value', async () => {
    const admin = makeAdminSession()
    mockDbQuery([dbAdminRow()])

    const res = await templatesPatch(
      adminPatch(TEMPLATE_URL, admin, { status: 'ESTADO_INVALIDO' }) as never,
      { params: Promise.resolve({ id: TEMPLATE_ID }) },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Validation failed')
  })
})
