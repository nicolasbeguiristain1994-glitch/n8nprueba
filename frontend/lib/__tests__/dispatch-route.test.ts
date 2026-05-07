/**
 * dispatch/route.ts — route-level tests
 *
 * Tests POST /api/campaigns/[id]/dispatch (multi-line path).
 * processMultiLineInBackground is mocked — processor logic is not tested here.
 *
 * Covers:
 *  1. Campaign not found → 404
 *  2. Forbidden → 403
 *  3. Status not resumable → 409
 *  4. No eligible contacts → 400 with breakdown
 *  5. All contacts already processed → 409 "ya completada"
 *  6. Lock already held → 200 { alreadyProcessing: true }
 *  7. Happy path → 200 { started: true }
 *  8. GET returns dispatch summary
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db', () => ({ query: vi.fn() }))
vi.mock('@/lib/permissions', () => ({
  checkPermissionWithUser: vi.fn(),
  isCampaignOwnerOrAdmin:  vi.fn(),
}))
vi.mock('@/lib/validate', () => ({ isUUID: vi.fn().mockReturnValue(true) }))
vi.mock('@/lib/audit',   () => ({ audit: vi.fn() }))
vi.mock('@/lib/campaign-distributor', () => ({
  createDispatchUnits:            vi.fn(),
  acquireProcessorLock:           vi.fn(),
  processMultiLineInBackground:   vi.fn().mockResolvedValue(undefined),
  getDispatchSummary:             vi.fn(),
  getContactEligibilityBreakdown: vi.fn(),
  formatEligibilityError:         vi.fn(),
}))
vi.mock('@/lib/campaign-logger', () => ({ clog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import * as db          from '@/lib/db'
import * as permissions from '@/lib/permissions'
import * as validate    from '@/lib/validate'
import * as dist        from '@/lib/campaign-distributor'
import { POST, GET }    from '@/app/api/campaigns/[id]/dispatch/route'

// ── Helpers ───────────────────────────────────────────────────────────────────

const CAMPAIGN_ID = '22222222-2222-2222-2222-222222222222'
const USER_ID     = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

function makeReq(method = 'POST'): Request {
  return new Request(`http://localhost/api/campaigns/${CAMPAIGN_ID}/dispatch`, { method })
}

function makeParams(id = CAMPAIGN_ID) {
  return { params: Promise.resolve({ id }) }
}

function allowAuth() {
  vi.mocked(permissions.checkPermissionWithUser).mockResolvedValue({
    ok:   true,
    user: { user_id: USER_ID, role: 'admin', sectors: ['send'] },
  } as never)
  vi.mocked(permissions.isCampaignOwnerOrAdmin).mockReturnValue(true)
}

function makeCampaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN_ID, name: 'Test', message: 'Hola', status: 'draft',
    list_id: 'list-uuid', owned_by: USER_ID, ...overrides,
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(() => { process.env.AUTH_SECRET = 'test-secret' })
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(validate.isUUID).mockReturnValue(true)
})

// ── 1. Campaign not found ─────────────────────────────────────────────────────

describe('campaign not found', () => {
  it('returns 404', async () => {
    allowAuth()
    vi.mocked(db.query).mockResolvedValueOnce([])  // SELECT campaign

    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(404)
  })
})

// ── 2. Forbidden ──────────────────────────────────────────────────────────────

describe('forbidden', () => {
  it('returns 403 when user does not own campaign', async () => {
    vi.mocked(permissions.checkPermissionWithUser).mockResolvedValue({
      ok: true, user: { user_id: 'other', role: 'operator', sectors: ['send'] },
    } as never)
    vi.mocked(permissions.isCampaignOwnerOrAdmin).mockReturnValue(false)
    vi.mocked(db.query).mockResolvedValueOnce([makeCampaignRow({ owned_by: 'someone-else' })])

    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(403)
  })
})

// ── 3. Status not resumable ───────────────────────────────────────────────────

describe('status not resumable', () => {
  it('returns 409 for completed campaign', async () => {
    allowAuth()
    vi.mocked(db.query).mockResolvedValueOnce([makeCampaignRow({ status: 'completed' })])

    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('completed')
  })
})

// ── 4. No eligible contacts ───────────────────────────────────────────────────

describe('no eligible contacts', () => {
  it('returns 400 with eligibility breakdown', async () => {
    allowAuth()
    vi.mocked(db.query).mockResolvedValueOnce([makeCampaignRow()])
    vi.mocked(dist.createDispatchUnits).mockResolvedValueOnce({ total: 0, queued: 0 })
    vi.mocked(dist.getContactEligibilityBreakdown).mockResolvedValueOnce({
      total_in_list: 30, eligible: 0, opted_out: 30,
      do_not_contact: 0, inactive: 0, blacklisted: 0,
    })
    vi.mocked(dist.formatEligibilityError).mockReturnValue(
      'No hay contactos elegibles (30 en lista). Excluidos: 30 sin opt-in de marketing.'
    )

    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('opt-in')
    expect(body.breakdown).toBeDefined()
    expect(body.breakdown.opted_out).toBe(30)
  })
})

// ── 5. All contacts already processed ────────────────────────────────────────

describe('all contacts already processed', () => {
  it('returns 409 and marks campaign completed', async () => {
    allowAuth()
    vi.mocked(db.query)
      .mockResolvedValueOnce([makeCampaignRow({ status: 'paused' })])
      .mockResolvedValueOnce([{ count: '10' }])   // processed count
      .mockResolvedValueOnce([])                   // UPDATE completed
    vi.mocked(dist.createDispatchUnits).mockResolvedValueOnce({ total: 10, queued: 0 })

    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('completada')
  })
})

// ── 6. Lock already held ──────────────────────────────────────────────────────

describe('processor lock already held', () => {
  it('returns { alreadyProcessing: true } when lock is taken', async () => {
    allowAuth()
    vi.mocked(db.query).mockResolvedValueOnce([makeCampaignRow({ status: 'running' })])
    vi.mocked(dist.createDispatchUnits).mockResolvedValueOnce({ total: 10, queued: 5 })
    vi.mocked(dist.acquireProcessorLock).mockResolvedValueOnce(null)  // lock held

    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.started).toBe(false)
    expect(body.alreadyProcessing).toBe(true)
  })
})

// ── 7. Happy path ─────────────────────────────────────────────────────────────

describe('happy path POST', () => {
  it('returns { started: true } and fires processMultiLineInBackground', async () => {
    allowAuth()
    vi.mocked(db.query).mockResolvedValueOnce([makeCampaignRow()])
    vi.mocked(dist.createDispatchUnits).mockResolvedValueOnce({ total: 20, queued: 20 })
    vi.mocked(dist.acquireProcessorLock).mockResolvedValueOnce('lock-token-abc')

    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.started).toBe(true)
    expect(body.total).toBe(20)
    expect(body.queued).toBe(20)
  })
})

// ── 8. GET returns summary ────────────────────────────────────────────────────

describe('GET dispatch summary', () => {
  it('returns campaign status and dispatch summary', async () => {
    vi.mocked(permissions.checkPermissionWithUser).mockResolvedValue({
      ok: true, user: { user_id: USER_ID, role: 'admin', sectors: ['campaigns'] },
    } as never)
    vi.mocked(permissions.isCampaignOwnerOrAdmin).mockReturnValue(true)
    vi.mocked(db.query).mockResolvedValueOnce([
      { id: CAMPAIGN_ID, status: 'running', owned_by: USER_ID },
    ])
    vi.mocked(dist.getDispatchSummary).mockResolvedValueOnce({
      total: 100, queued: 20, processing: 2, sent: 70, failed: 5, skipped: 3,
      eligible_lines: 3,
      line_usage: [{ line_id: 'l1', line_key: 'line_01', display_name: 'Línea 01', sent: 70, failed: 5 }],
      top_errors: [],
    })

    const res = await GET(makeReq('GET'), makeParams())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('running')
    expect(body.total).toBe(100)
    expect(body.sent).toBe(70)
    expect(body.skipped).toBe(3)
    expect(body.eligible_lines).toBe(3)
  })

  it('returns 404 when campaign not found', async () => {
    vi.mocked(permissions.checkPermissionWithUser).mockResolvedValue({
      ok: true, user: { user_id: USER_ID, role: 'admin', sectors: ['campaigns'] },
    } as never)
    vi.mocked(db.query).mockResolvedValueOnce([])

    const res = await GET(makeReq('GET'), makeParams())
    expect(res.status).toBe(404)
  })
})
