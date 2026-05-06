/**
 * send/route.ts — route-level tests
 *
 * Tests the HTTP layer of POST /api/campaigns/[id]/send.
 * processInBackground is mocked — its behavior is covered by send-processor.test.ts.
 *
 * Covers:
 *  1. Missing N8N_URL env var → 500
 *  2. Invalid UUID → 400
 *  3. Campaign not found → 404
 *  4. Forbidden (not owner) → 403
 *  5. Status not resumable (completed) → 409
 *  6. Campaign has no contacts (new) → 400 with eligibility hint
 *  7. All contacts already processed → 409 "ya completada"
 *  8. Processor lock already held → 200 { alreadyProcessing: true }
 *  9. Happy path → 200 { started: true }
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db', () => ({ query: vi.fn() }))
vi.mock('@/lib/permissions', () => ({
  checkPermissionWithUser: vi.fn(),
  isCampaignOwnerOrAdmin:  vi.fn(),
}))
vi.mock('@/lib/validate', () => ({ isUUID: vi.fn() }))
vi.mock('@/lib/audit',   () => ({ audit: vi.fn() }))
vi.mock('@/lib/send-processor', () => ({
  processInBackground:    vi.fn().mockResolvedValue(undefined),
  PROCESSOR_LOCK_MINUTES: 30,
}))
vi.mock('@/lib/campaign-logger', () => ({ clog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import * as db          from '@/lib/db'
import * as permissions from '@/lib/permissions'
import * as validate    from '@/lib/validate'
import { POST }         from '@/app/api/campaigns/[id]/send/route'

// ── Helpers ───────────────────────────────────────────────────────────────────

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111'
const USER_ID     = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function makeReq(method = 'POST'): NextRequest {
  return new NextRequest(`http://localhost/api/campaigns/${CAMPAIGN_ID}/send`, { method })
}

function makeParams(id = CAMPAIGN_ID) {
  return { params: Promise.resolve({ id }) }
}

function allowAuth(owned_by = USER_ID) {
  vi.mocked(permissions.checkPermissionWithUser).mockResolvedValue({
    ok:   true,
    user: { user_id: USER_ID, role: 'admin', sectors: ['send'], owned_by },
  } as never)
  vi.mocked(permissions.isCampaignOwnerOrAdmin).mockReturnValue(true)
}

function makeCampaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id:                  CAMPAIGN_ID,
    name:                'Test',
    message:             'Hola',
    messages:            null,
    media_url:           '',
    list_id:             'list-uuid',
    antiblock_delay_min: 1,
    antiblock_delay_max: 3,
    personalize_name:    true,
    status:              'draft',
    owned_by:            USER_ID,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.AUTH_SECRET = 'test-secret'
})

beforeEach(() => {
  vi.resetAllMocks()
  process.env.N8N_URL = 'http://n8n:5678'
  vi.mocked(validate.isUUID).mockReturnValue(true)
})

afterEach(() => {
  delete process.env.N8N_URL
})

// ── 1. Missing N8N_URL ────────────────────────────────────────────────────────

describe('missing N8N_URL', () => {
  it('returns 500 when N8N_URL is not set', async () => {
    delete process.env.N8N_URL
    allowAuth()
    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('N8N_URL')
  })
})

// ── 2. Invalid UUID ───────────────────────────────────────────────────────────

describe('invalid UUID', () => {
  it('returns 400 for non-UUID id', async () => {
    vi.mocked(validate.isUUID).mockReturnValue(false)
    allowAuth()
    const res = await POST(makeReq(), makeParams('not-a-uuid'))
    expect(res.status).toBe(400)
  })
})

// ── 3. Campaign not found ─────────────────────────────────────────────────────

describe('campaign not found', () => {
  it('returns 404 when campaign does not exist', async () => {
    allowAuth()
    vi.mocked(db.query).mockResolvedValueOnce([])  // SELECT campaign → empty
    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(404)
  })
})

// ── 4. Forbidden ──────────────────────────────────────────────────────────────

describe('forbidden', () => {
  it('returns 403 when user does not own the campaign', async () => {
    vi.mocked(permissions.checkPermissionWithUser).mockResolvedValue({
      ok:   true,
      user: { user_id: 'other-user', role: 'operator', sectors: ['send'] },
    } as never)
    vi.mocked(permissions.isCampaignOwnerOrAdmin).mockReturnValue(false)
    vi.mocked(db.query).mockResolvedValueOnce([makeCampaignRow({ owned_by: 'other-owner' })])

    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(403)
  })
})

// ── 5. Status not resumable ───────────────────────────────────────────────────

describe('status not resumable', () => {
  it('returns 409 for completed campaign', async () => {
    allowAuth()
    vi.mocked(db.query).mockResolvedValueOnce([makeCampaignRow({ status: 'completed' })])
    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('completed')
  })

  it('returns 409 for cancelled campaign', async () => {
    allowAuth()
    vi.mocked(db.query).mockResolvedValueOnce([makeCampaignRow({ status: 'cancelled' })])
    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(409)
  })
})

// ── 6. No eligible contacts ───────────────────────────────────────────────────

describe('no eligible contacts', () => {
  it('returns 400 with eligibility explanation when list has no eligible contacts', async () => {
    allowAuth()
    vi.mocked(db.query)
      .mockResolvedValueOnce([makeCampaignRow()])          // SELECT campaign
      .mockResolvedValueOnce([{ count: '0' }])             // blacklist count
      .mockResolvedValueOnce([])                           // INSERT recipients (0 rows)
      .mockResolvedValueOnce([{ count: '0' }])             // COUNT pending
      .mockResolvedValueOnce([{ total: '0', sent: '0' }])  // processed check
      // eligibility breakdown
      .mockResolvedValueOnce([{
        total_in_list: '50', opted_out: '50', do_not_contact: '0',
        inactive: '0', blacklisted: '0',
      }])

    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('50')
    expect(body.error).toContain('opt-in')
  })

  it('returns 400 with "sin contactos" when list is empty', async () => {
    allowAuth()
    vi.mocked(db.query)
      .mockResolvedValueOnce([makeCampaignRow()])
      .mockResolvedValueOnce([{ count: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: '0' }])
      .mockResolvedValueOnce([{ total: '0', sent: '0' }])
      .mockResolvedValueOnce([{
        total_in_list: '0', opted_out: '0', do_not_contact: '0',
        inactive: '0', blacklisted: '0',
      }])

    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('contactos')
  })
})

// ── 7. All contacts already processed ────────────────────────────────────────

describe('all contacts already processed', () => {
  it('returns 409 and marks campaign completed when all recipients are done', async () => {
    allowAuth()
    vi.mocked(db.query)
      .mockResolvedValueOnce([makeCampaignRow({ status: 'paused' })])
      .mockResolvedValueOnce([{ count: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: '0' }])
      // totals: 10 total, 10 already sent/failed/skipped
      .mockResolvedValueOnce([{ total: '10', sent: '10' }])
      .mockResolvedValueOnce([])  // UPDATE campaigns SET status='completed'

    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('completada')

    // Verify the completion UPDATE was issued
    const queries = vi.mocked(db.query).mock.calls.map(c => String(c[0]))
    const completedQuery = queries.find(q => q.includes("status = 'completed'"))
    expect(completedQuery).toBeDefined()
  })
})

// ── 8. Lock already held ──────────────────────────────────────────────────────

describe('processor lock already held', () => {
  it('returns { started: false, alreadyProcessing: true } when lock is taken', async () => {
    allowAuth()
    vi.mocked(db.query)
      .mockResolvedValueOnce([makeCampaignRow({ status: 'running' })])
      .mockResolvedValueOnce([{ count: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: '5' }])  // pending > 0
      .mockResolvedValueOnce([])                // UPDATE (lock attempt) → 0 rows = lock held

    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.started).toBe(false)
    expect(body.alreadyProcessing).toBe(true)
  })
})

// ── 9. Happy path ─────────────────────────────────────────────────────────────

describe('happy path', () => {
  it('returns { started: true } and fires processInBackground', async () => {
    const { processInBackground } = await import('@/lib/send-processor')
    allowAuth()
    vi.mocked(db.query)
      .mockResolvedValueOnce([makeCampaignRow()])
      .mockResolvedValueOnce([{ count: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: '10' }])  // pending = 10
      // UPDATE lock → 1 row (lock acquired)
      .mockResolvedValueOnce([{ id: CAMPAIGN_ID }])

    const res = await POST(makeReq(), makeParams())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.started).toBe(true)
    expect(body.total).toBe(10)

    // Give fire-and-forget a tick to start
    await new Promise(r => setImmediate(r))
    expect(processInBackground).toHaveBeenCalled()
  })
})
