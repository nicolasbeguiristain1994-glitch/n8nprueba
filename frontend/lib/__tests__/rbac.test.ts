/**
 * RBAC unit tests
 *
 * Covers the 8 acceptance cases:
 *
 *  1. Admin sees Usuarios and Audit (canAccess admin/users/manage + admin/audit/read)
 *  2. Operator does not see Usuarios (canAccess operator/users/manage → false)
 *  3. Viewer does not see Usuarios   (canAccess viewer/users/manage → false)
 *  4. Operator with sectors["campaigns"] → GET /api/campaigns (read ✓), POST /api/send (✗)
 *  5. Operator with sectors["send"] → POST /api/send (send ✓)
 *  6. Viewer with sectors["campaigns"] → GET /api/campaigns (read ✓), POST /api/campaigns (✗)
 *  7. No cookie → checkPermission returns 401
 *  8. Valid cookie, missing permission → checkPermission returns 403
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { canAccess, checkPermission, isCampaignOwnerOrAdmin, isOwnerOrAdmin } from '@/lib/permissions'
import { createSessionToken } from '@/lib/auth'
import type { SessionUser }   from '@/lib/auth'

// ── Helpers ───────────────────────────────────────────────────────────────────

const AUTH_SECRET = 'test-secret-for-rbac-unit-tests'

beforeAll(() => {
  process.env.AUTH_SECRET = AUTH_SECRET
})

function makeSession(override: Partial<SessionUser> = {}): SessionUser {
  const now = Math.floor(Date.now() / 1000)
  return {
    user_id:         'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
    email:           'test@example.com',
    name:            'Test',
    role:            'viewer',
    sectors:         [],
    session_version: 1,
    iat:             now,
    exp:             now + 3600,
    nonce:           'test-nonce',
    ...override,
  }
}

/** Build a Request whose Cookie header carries a signed session cookie. */
function makeReqWithSession(session: SessionUser): Request {
  const token = createSessionToken(session)
  return new Request('http://localhost/api/test', {
    headers: { cookie: `session=${token}` },
  })
}

/** Build a Request with no cookie. */
function makeReqNoCookie(): Request {
  return new Request('http://localhost/api/test')
}

// ── Case 1: Admin sees Usuarios and Audit ─────────────────────────────────────

describe('Case 1 — admin can access users/manage and audit/read', () => {
  const admin = makeSession({ role: 'admin', sectors: [] })

  it('canAccess(admin, users, manage) → true', () => {
    expect(canAccess(admin, 'users', 'manage')).toBe(true)
  })

  it('canAccess(admin, audit, read) → true', () => {
    expect(canAccess(admin, 'audit', 'read')).toBe(true)
  })
})

// ── Case 2: Operator does not see Usuarios ────────────────────────────────────

describe('Case 2 — operator cannot access users/manage', () => {
  const op = makeSession({ role: 'operator', sectors: ['users'] })

  it('canAccess(operator, users, manage) → false even with users sector', () => {
    expect(canAccess(op, 'users', 'manage')).toBe(false)
  })
})

// ── Case 3: Viewer does not see Usuarios ─────────────────────────────────────

describe('Case 3 — viewer cannot access users/manage', () => {
  const viewer = makeSession({ role: 'viewer', sectors: ['users'] })

  it('canAccess(viewer, users, manage) → false even with users sector', () => {
    expect(canAccess(viewer, 'users', 'manage')).toBe(false)
  })
})

// ── Case 4: Operator[campaigns] → campaigns:read ✓, send:send ✗ ──────────────

describe('Case 4 — operator with sectors["campaigns"]', () => {
  const op = makeSession({ role: 'operator', sectors: ['campaigns'] })

  it('canAccess(op, campaigns, read) → true', () => {
    expect(canAccess(op, 'campaigns', 'read')).toBe(true)
  })

  it('canAccess(op, send, send) → false (no send sector)', () => {
    expect(canAccess(op, 'send', 'send')).toBe(false)
  })
})

// ── Case 5: Operator[send] → send:send ✓ ─────────────────────────────────────

describe('Case 5 — operator with sectors["send"]', () => {
  const op = makeSession({ role: 'operator', sectors: ['send'] })

  it('canAccess(op, send, send) → true', () => {
    expect(canAccess(op, 'send', 'send')).toBe(true)
  })
})

// ── Case 6: Viewer[campaigns] → campaigns:read ✓, campaigns:create ✗ ─────────

describe('Case 6 — viewer with sectors["campaigns"]', () => {
  const viewer = makeSession({ role: 'viewer', sectors: ['campaigns'] })

  it('canAccess(viewer, campaigns, read) → true', () => {
    expect(canAccess(viewer, 'campaigns', 'read')).toBe(true)
  })

  it('canAccess(viewer, campaigns, create) → false', () => {
    expect(canAccess(viewer, 'campaigns', 'create')).toBe(false)
  })
})

// ── Case 7: No cookie → 401 ───────────────────────────────────────────────────

describe('Case 7 — no cookie returns 401', () => {
  it('checkPermission with no cookie → 401', async () => {
    const req = makeReqNoCookie()
    const res = checkPermission(req, 'campaigns', 'read')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
    const body = await res!.json()
    expect(body.error).toBe('Unauthorized')
  })
})

// ── Case 8: Valid cookie, missing permission → 403 ───────────────────────────

describe('Case 8 — valid cookie but insufficient permission returns 403', () => {
  it('operator with sectors["campaigns"] calling send/send → 403', async () => {
    const session = makeSession({ role: 'operator', sectors: ['campaigns'] })
    const req = makeReqWithSession(session)
    const res = checkPermission(req, 'send', 'send')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    const body = await res!.json()
    expect(body.error).toBe('Forbidden')
  })

  it('viewer calling campaigns/create → 403', async () => {
    const session = makeSession({ role: 'viewer', sectors: ['campaigns'] })
    const req = makeReqWithSession(session)
    const res = checkPermission(req, 'campaigns', 'create')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    const body = await res!.json()
    expect(body.error).toBe('Forbidden')
  })

  it('operator calling users/manage → 403', async () => {
    const session = makeSession({ role: 'operator', sectors: ['users'] })
    const req = makeReqWithSession(session)
    const res = checkPermission(req, 'users', 'manage')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    const body = await res!.json()
    expect(body.error).toBe('Forbidden')
  })
})

// ── Bonus: valid cookie + correct permission → null (pass-through) ────────────

describe('Bonus — valid cookie with correct permission passes through', () => {
  it('checkPermission returns null for admin on any resource', () => {
    const session = makeSession({ role: 'admin', sectors: [] })
    const req = makeReqWithSession(session)
    expect(checkPermission(req, 'campaigns', 'read')).toBeNull()
    expect(checkPermission(req, 'users', 'manage')).toBeNull()
    expect(checkPermission(req, 'audit', 'read')).toBeNull()
  })

  it('checkPermission returns null for operator[campaigns] on campaigns/read', () => {
    const session = makeSession({ role: 'operator', sectors: ['campaigns'] })
    const req = makeReqWithSession(session)
    expect(checkPermission(req, 'campaigns', 'read')).toBeNull()
  })
})

// ── Campaign ownership (isCampaignOwnerOrAdmin) ───────────────────────────────
//
//  Rules:
//    admin              → always true (sees all including NULL-owned historical)
//    ownedBy === null   → false for non-admin (historical are admin-only)
//    ownedBy === userId → true  (own campaign)
//    ownedBy !== userId → false (someone else's)

const SELF_ID  = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa'  // matches makeSession default
const OTHER_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb'

describe('isCampaignOwnerOrAdmin — admin', () => {
  const admin = makeSession({ role: 'admin', sectors: [] })

  it('admin + owned by another user → true', () => {
    expect(isCampaignOwnerOrAdmin(admin, OTHER_ID)).toBe(true)
  })

  it('admin + owned_by = null (historical) → true', () => {
    expect(isCampaignOwnerOrAdmin(admin, null)).toBe(true)
  })
})

describe('isCampaignOwnerOrAdmin — operator', () => {
  const op = makeSession({ role: 'operator', sectors: ['campaigns', 'send'] })

  it('operator + owned by self → true', () => {
    expect(isCampaignOwnerOrAdmin(op, SELF_ID)).toBe(true)
  })

  it('operator + owned by another user → false', () => {
    expect(isCampaignOwnerOrAdmin(op, OTHER_ID)).toBe(false)
  })

  it('operator + owned_by = null (historical) → false', () => {
    expect(isCampaignOwnerOrAdmin(op, null)).toBe(false)
  })
})

describe('isCampaignOwnerOrAdmin — viewer', () => {
  const viewer = makeSession({ role: 'viewer', sectors: ['campaigns'] })

  it('viewer + owned by self → true (read-through)', () => {
    expect(isCampaignOwnerOrAdmin(viewer, SELF_ID)).toBe(true)
  })

  it('viewer + owned by another user → false', () => {
    expect(isCampaignOwnerOrAdmin(viewer, OTHER_ID)).toBe(false)
  })

  it('viewer + owned_by = null (historical) → false', () => {
    expect(isCampaignOwnerOrAdmin(viewer, null)).toBe(false)
  })

  it('viewer can pass ownership check but canAccess still blocks create', () => {
    // Ownership check passes (self-owned), but RBAC gate blocks mutation
    expect(isCampaignOwnerOrAdmin(viewer, SELF_ID)).toBe(true)
    expect(canAccess(viewer, 'campaigns', 'create')).toBe(false)
    expect(canAccess(viewer, 'campaigns', 'update')).toBe(false)
  })
})

// ── isOwnerOrAdmin (generic helper) ──────────────────────────────────────────
//
//  isCampaignOwnerOrAdmin is an alias — same logic, different name.
//  These tests cover the generic helper used by contact_lists and future resources.

describe('isOwnerOrAdmin — admin', () => {
  const admin = makeSession({ role: 'admin', sectors: [] })

  it('admin + owned by self → true', () => {
    expect(isOwnerOrAdmin(admin, SELF_ID)).toBe(true)
  })

  it('admin + owned by another user → true', () => {
    expect(isOwnerOrAdmin(admin, OTHER_ID)).toBe(true)
  })

  it('admin + owned_by = null (historical) → true', () => {
    expect(isOwnerOrAdmin(admin, null)).toBe(true)
  })
})

describe('isOwnerOrAdmin — operator', () => {
  const op = makeSession({ role: 'operator', sectors: ['lists'] })

  it('operator + owned by self → true', () => {
    expect(isOwnerOrAdmin(op, SELF_ID)).toBe(true)
  })

  it('operator + owned by another user → false', () => {
    expect(isOwnerOrAdmin(op, OTHER_ID)).toBe(false)
  })

  it('operator + owned_by = null (historical) → false', () => {
    expect(isOwnerOrAdmin(op, null)).toBe(false)
  })
})

describe('isOwnerOrAdmin — viewer', () => {
  const viewer = makeSession({ role: 'viewer', sectors: ['lists'] })

  it('viewer + owned by self → true (read-through)', () => {
    expect(isOwnerOrAdmin(viewer, SELF_ID)).toBe(true)
  })

  it('viewer + owned by another user → false', () => {
    expect(isOwnerOrAdmin(viewer, OTHER_ID)).toBe(false)
  })

  it('viewer + owned_by = null (historical) → false', () => {
    expect(isOwnerOrAdmin(viewer, null)).toBe(false)
  })

  it('viewer ownership passes but canAccess still blocks create on lists', () => {
    expect(isOwnerOrAdmin(viewer, SELF_ID)).toBe(true)
    expect(canAccess(viewer, 'lists', 'create')).toBe(false)
    expect(canAccess(viewer, 'lists', 'update')).toBe(false)
  })
})

describe('isOwnerOrAdmin — alias consistency', () => {
  it('isCampaignOwnerOrAdmin and isOwnerOrAdmin return identical results', () => {
    const op = makeSession({ role: 'operator', sectors: ['campaigns'] })
    for (const ownedBy of [SELF_ID, OTHER_ID, null]) {
      expect(isCampaignOwnerOrAdmin(op, ownedBy)).toBe(isOwnerOrAdmin(op, ownedBy))
    }
  })
})
