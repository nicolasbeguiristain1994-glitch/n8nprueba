// @vitest-environment node
/**
 * grants-route.test.ts
 *
 * Security and authorization tests for GET / POST / DELETE /api/lines/grants.
 *
 * Strategy:
 *   - checkPermissionWithUser → mocked to control auth
 *   - canManageLineGrant      → mocked to control line-level authorization
 *   - getAccessibleLineIds    → mocked to control visibility scope
 *   - db.query                → mocked for DB operations
 *
 * The tests verify that the HTTP layer enforces every authorization branch
 * documented in the route file, without touching a live database.
 *
 * Coverage:
 *  GET:
 *    1. Unauthenticated request → passthrough from checkPermissionWithUser
 *    2. Missing line_id query param → 400
 *    3. Invalid (non-UUID) line_id → 400
 *    4. Operator: line outside their scope → 404
 *    5. Admin: accessible line → 200 with grants
 *    6. Super admin (null id set) → can list grants for any line
 *    7. Operator cannot see grants for a line not in their accessible set
 *
 *  POST:
 *    8.  Unauthenticated → passthrough
 *    9.  Self-grant → 400
 *    10. canManageLineGrant = false → 403
 *    11. Admin cannot grant over another admin's line (canManageLineGrant=false → 403)
 *    12. Grantee does not exist → 404
 *    13. Grantee is inactive → 404
 *    14. Admin grants to operator not under their direct management → 403
 *    15. super_admin can grant to any operator regardless of manager_id
 *    16. super_admin can grant over legacy NULL-owner lines
 *    17. Admin happy path → 201 with grant id
 *    18. Duplicate grant → ON CONFLICT DO NOTHING → 200 already_existed:true
 *    19. INSERT receives correct params (line_id, granted_to, actor)
 *
 *  DELETE:
 *    20. Unauthenticated → passthrough
 *    21. canManageLineGrant = false → 403
 *    22. Grant not found → 404
 *    23. super_admin can revoke any grant
 *    24. Authorized actor happy path → 200 ok:true
 *    25. DELETE query params order (line_id, granted_to)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest }                          from 'next/server'
import type { SessionUser }                     from '@/lib/auth'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db', () => ({ query: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: vi.fn() }))
vi.mock('@/lib/audit',       () => ({ audit: vi.fn() }))
vi.mock('@/lib/line-visibility', () => ({
  canManageLineGrant:   vi.fn(),
  getAccessibleLineIds: vi.fn(),
}))

import * as db          from '@/lib/db'
import * as permissions from '@/lib/permissions'
import * as visibility  from '@/lib/line-visibility'
import { GET, POST, DELETE } from '@/app/api/lines/grants/route'

// ── Fixtures ───────────────────────────────────────────────────────────────────

// Proper RFC 4122 v4 UUIDs (version nibble = 4, variant nibble = 8)
const LINE_A       = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LINE_LEGACY  = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const ADMIN_ID     = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OPERATOR_ID  = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const GRANT_ID     = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function makeUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    user_id:               ADMIN_ID,
    email:                 'admin@test.com',
    name:                  'Admin',
    role:                  'admin',
    sectors:               [],
    session_version:       1,
    can_download_contacts: true,
    allowed_agents:        [],
    is_super_admin:        false,
    iat:                   0,
    exp:                   9999999999,
    nonce:                 'test',
    ...overrides,
  }
}

function allowAuth(user: SessionUser) {
  vi.mocked(permissions.checkPermissionWithUser).mockResolvedValue({
    ok: true,
    user,
  } as never)
}

function denyAuth() {
  vi.mocked(permissions.checkPermissionWithUser).mockResolvedValue({
    ok:       false,
    response: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
  } as never)
}

function makeGetReq(lineId?: string): NextRequest {
  const url = lineId
    ? `http://localhost/api/lines/grants?line_id=${lineId}`
    : `http://localhost/api/lines/grants`
  return new NextRequest(url)
}

function makePostReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/lines/grants', {
    method:  'POST',
    body:    JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function makeDeleteReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/lines/grants', {
    method:  'DELETE',
    body:    JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

// ── GET /api/lines/grants ─────────────────────────────────────────────────────

describe('GET /api/lines/grants', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('passes through auth failure from checkPermissionWithUser', async () => {
    denyAuth()

    const res = await GET(makeGetReq(LINE_A))

    expect(res.status).toBe(401)
    expect(vi.mocked(visibility.getAccessibleLineIds)).not.toHaveBeenCalled()
  })

  it('returns 400 when line_id query param is missing', async () => {
    allowAuth(makeUser())

    const res = await GET(makeGetReq())

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('line_id')
  })

  it('returns 400 when line_id is not a valid UUID', async () => {
    allowAuth(makeUser())

    const res = await GET(new NextRequest('http://localhost/api/lines/grants?line_id=not-a-uuid'))

    expect(res.status).toBe(400)
  })

  it('returns 404 when line is outside the caller\'s visibility scope', async () => {
    const operator = makeUser({ user_id: OPERATOR_ID, role: 'operator' })
    allowAuth(operator)
    vi.mocked(visibility.getAccessibleLineIds).mockResolvedValue([])  // LINE_A not in scope

    const res = await GET(makeGetReq(LINE_A))

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('not accessible')
  })

  it('admin can list grants for an accessible line', async () => {
    allowAuth(makeUser())
    vi.mocked(visibility.getAccessibleLineIds).mockResolvedValue([LINE_A])
    vi.mocked(db.query).mockResolvedValue([
      {
        id:            GRANT_ID,
        line_id:       LINE_A,
        granted_to:    OPERATOR_ID,
        grantee_name:  'Operator',
        grantee_email: 'op@test.com',
        grantee_role:  'operator',
        granted_by:    ADMIN_ID,
        granter_name:  'Admin',
        granter_email: 'admin@test.com',
        created_at:    new Date().toISOString(),
      },
    ])

    const res = await GET(makeGetReq(LINE_A))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.grants).toHaveLength(1)
    expect(body.grants[0].granted_to).toBe(OPERATOR_ID)
  })

  it('super_admin (getAccessibleLineIds=null) can list grants for any line', async () => {
    const superAdmin = makeUser({ is_super_admin: true })
    allowAuth(superAdmin)
    // null means "unlimited visibility" — skips the scope check
    vi.mocked(visibility.getAccessibleLineIds).mockResolvedValue(null)
    vi.mocked(db.query).mockResolvedValue([])

    const res = await GET(makeGetReq(LINE_A))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.grants).toEqual([])
  })

  it('super_admin can list grants even for legacy NULL-owner lines', async () => {
    const superAdmin = makeUser({ is_super_admin: true })
    allowAuth(superAdmin)
    vi.mocked(visibility.getAccessibleLineIds).mockResolvedValue(null)
    vi.mocked(db.query).mockResolvedValue([])

    const res = await GET(makeGetReq(LINE_LEGACY))

    expect(res.status).toBe(200)
  })

  it('operator cannot see grants for a line not in their accessible set', async () => {
    const operator = makeUser({ user_id: OPERATOR_ID, role: 'operator' })
    allowAuth(operator)
    // Operator has access to a different line, not LINE_A
    vi.mocked(visibility.getAccessibleLineIds).mockResolvedValue(['ffffffff-ffff-ffff-ffff-ffffffffffff'])

    const res = await GET(makeGetReq(LINE_A))

    expect(res.status).toBe(404)
  })
})

// ── POST /api/lines/grants ────────────────────────────────────────────────────

describe('POST /api/lines/grants', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('passes through auth failure from checkPermissionWithUser', async () => {
    denyAuth()

    const res = await POST(makePostReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(401)
    expect(vi.mocked(visibility.canManageLineGrant)).not.toHaveBeenCalled()
  })

  it('returns 400 when actor tries to grant access to themselves', async () => {
    allowAuth(makeUser({ user_id: ADMIN_ID }))
    // canManageLineGrant should NOT even be called for self-grants
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(true)

    const res = await POST(makePostReq({ line_id: LINE_A, granted_to: ADMIN_ID }))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('propias')
  })

  it('returns 403 when canManageLineGrant returns false', async () => {
    allowAuth(makeUser())
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(false)

    const res = await POST(makePostReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toContain('Forbidden')
  })

  it('admin cannot grant over lines from another admin (canManageLineGrant=false)', async () => {
    // canManageLineGrant encapsulates all authorization logic for who owns the line
    allowAuth(makeUser())
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(false)

    const res = await POST(makePostReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(403)
  })

  it('returns 404 when grantee user does not exist in the database', async () => {
    allowAuth(makeUser())
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(true)
    vi.mocked(db.query).mockResolvedValueOnce([])  // grantee SELECT returns nothing

    const res = await POST(makePostReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('inactivo')
  })

  it('returns 404 when grantee is inactive', async () => {
    allowAuth(makeUser())
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(true)
    vi.mocked(db.query).mockResolvedValueOnce([{
      id: OPERATOR_ID, role: 'operator', is_active: false, manager_id: ADMIN_ID,
    }])

    const res = await POST(makePostReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(404)
  })

  it('admin cannot grant to an operator not under their direct management', async () => {
    allowAuth(makeUser({ user_id: ADMIN_ID }))
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(true)
    // Operator belongs to a different admin
    vi.mocked(db.query).mockResolvedValueOnce([{
      id: OPERATOR_ID, role: 'operator', is_active: true, manager_id: 'other-admin-id-here',
    }])

    const res = await POST(makePostReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toContain('directamente')
  })

  it('super_admin can grant to any operator regardless of manager_id', async () => {
    const superAdmin = makeUser({ is_super_admin: true })
    allowAuth(superAdmin)
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(true)
    // Operator managed by a different admin — irrelevant for super_admin
    vi.mocked(db.query).mockResolvedValueOnce([{
      id: OPERATOR_ID, role: 'operator', is_active: true, manager_id: 'different-admin-uuid',
    }])
    vi.mocked(db.query).mockResolvedValueOnce([{ id: GRANT_ID }])

    const res = await POST(makePostReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.id).toBe(GRANT_ID)
  })

  it('super_admin can grant over legacy NULL-owner lines', async () => {
    // canManageLineGrant returns true for super_admin even for NULL-owner lines
    const superAdmin = makeUser({ is_super_admin: true })
    allowAuth(superAdmin)
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(true)
    vi.mocked(db.query).mockResolvedValueOnce([{
      id: OPERATOR_ID, role: 'operator', is_active: true, manager_id: null,
    }])
    vi.mocked(db.query).mockResolvedValueOnce([{ id: GRANT_ID }])

    const res = await POST(makePostReq({ line_id: LINE_LEGACY, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(201)
  })

  it('admin can grant own line to their direct operator (happy path)', async () => {
    allowAuth(makeUser({ user_id: ADMIN_ID }))
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(true)
    vi.mocked(db.query).mockResolvedValueOnce([{
      id: OPERATOR_ID, role: 'operator', is_active: true, manager_id: ADMIN_ID,
    }])
    vi.mocked(db.query).mockResolvedValueOnce([{ id: GRANT_ID }])

    const res = await POST(makePostReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.id).toBe(GRANT_ID)
  })

  it('duplicate grant returns already_existed:true (idempotent — ON CONFLICT DO NOTHING)', async () => {
    allowAuth(makeUser({ user_id: ADMIN_ID }))
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(true)
    vi.mocked(db.query).mockResolvedValueOnce([{
      id: OPERATOR_ID, role: 'operator', is_active: true, manager_id: ADMIN_ID,
    }])
    // INSERT returned no rows — conflict → DO NOTHING
    vi.mocked(db.query).mockResolvedValueOnce([])

    const res = await POST(makePostReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.already_existed).toBe(true)
  })

  it('INSERT receives (line_id, granted_to, actorId) in that order', async () => {
    allowAuth(makeUser({ user_id: ADMIN_ID }))
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(true)
    vi.mocked(db.query).mockResolvedValueOnce([{
      id: OPERATOR_ID, role: 'operator', is_active: true, manager_id: ADMIN_ID,
    }])
    vi.mocked(db.query).mockResolvedValueOnce([{ id: GRANT_ID }])

    await POST(makePostReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    const [sql, params] = vi.mocked(db.query).mock.calls[1] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO line_grants')
    expect(params).toEqual([LINE_A, OPERATOR_ID, ADMIN_ID])
  })
})

// ── DELETE /api/lines/grants ──────────────────────────────────────────────────

describe('DELETE /api/lines/grants', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('passes through auth failure from checkPermissionWithUser', async () => {
    denyAuth()

    const res = await DELETE(makeDeleteReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(401)
    expect(vi.mocked(visibility.canManageLineGrant)).not.toHaveBeenCalled()
  })

  it('returns 403 when canManageLineGrant returns false', async () => {
    allowAuth(makeUser())
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(false)

    const res = await DELETE(makeDeleteReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toContain('Forbidden')
  })

  it('returns 404 when the grant does not exist', async () => {
    allowAuth(makeUser())
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(true)
    vi.mocked(db.query).mockResolvedValueOnce([])  // DELETE returned no rows

    const res = await DELETE(makeDeleteReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('not found')
  })

  it('super_admin can revoke any grant', async () => {
    const superAdmin = makeUser({ is_super_admin: true })
    allowAuth(superAdmin)
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(true)
    vi.mocked(db.query).mockResolvedValueOnce([{ id: GRANT_ID }])

    const res = await DELETE(makeDeleteReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('authorized actor can revoke a grant (happy path)', async () => {
    allowAuth(makeUser({ user_id: ADMIN_ID }))
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(true)
    vi.mocked(db.query).mockResolvedValueOnce([{ id: GRANT_ID }])

    const res = await DELETE(makeDeleteReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('DELETE query uses (line_id, granted_to) in the correct order', async () => {
    allowAuth(makeUser({ user_id: ADMIN_ID }))
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(true)
    vi.mocked(db.query).mockResolvedValueOnce([{ id: GRANT_ID }])

    await DELETE(makeDeleteReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('DELETE FROM line_grants')
    expect(params).toEqual([LINE_A, OPERATOR_ID])
  })

  it('canManageLineGrant is called with (actorId, line_id)', async () => {
    allowAuth(makeUser({ user_id: ADMIN_ID }))
    vi.mocked(visibility.canManageLineGrant).mockResolvedValue(true)
    vi.mocked(db.query).mockResolvedValueOnce([{ id: GRANT_ID }])

    await DELETE(makeDeleteReq({ line_id: LINE_A, granted_to: OPERATOR_ID }))

    expect(vi.mocked(visibility.canManageLineGrant)).toHaveBeenCalledWith(ADMIN_ID, LINE_A)
  })
})
