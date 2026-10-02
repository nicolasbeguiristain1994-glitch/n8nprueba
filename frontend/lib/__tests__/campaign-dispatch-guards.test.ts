// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn(), seed: vi.fn(), prospects: vi.fn(),
  lock: vi.fn(), single: vi.fn(), multi: vi.fn(), summary: vi.fn(), breakdown: vi.fn(),
  warn: vi.fn(), critical: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/permissions', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/permissions')>(), checkPermissionWithUser: mocks.auth,
}))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/send-processor', () => ({ processInBackground: mocks.single, PROCESSOR_LOCK_MINUTES: 30 }))
vi.mock('@/lib/campaign-distributor', () => ({ createDispatchUnits: mocks.seed,
  createDispatchUnitsFromProspectList: mocks.prospects, acquireProcessorLock: mocks.lock,
  processMultiLineInBackground: mocks.multi, getDispatchSummary: mocks.summary,
  getContactEligibilityBreakdown: mocks.breakdown, formatEligibilityError: () => 'Lista vacía',
}))
vi.mock('@/lib/campaign-logger', () => ({ clog: {
  info: vi.fn(), warn: mocks.warn, error: vi.fn(), critical: mocks.critical,
} }))
import { POST as send } from '@/app/api/campaigns/[id]/send/route'
import { POST as dispatch } from '@/app/api/campaigns/[id]/dispatch/route'
import { POST as processRoute } from '@/app/api/campaigns/[id]/dispatch/process/route'

const id = '11111111-1111-4111-8111-111111111111'
const ownerId = '22222222-2222-4222-8222-222222222222'
const routes = [['send', send], ['dispatch', dispatch], ['process', processRoute]] as const
let campaign: Record<string, unknown>
let listOwner: string | null
let missingList: boolean
let rejectQuery: string | undefined
let pending: string
let processed: string
let updated: { id: string }[]

function invoke(route: typeof send | typeof dispatch | typeof processRoute) {
  return route(new NextRequest(`http://localhost/api/campaigns/${id}`, { method: 'POST' }), { params: Promise.resolve({ id }) })
}
beforeEach(() => {
  vi.resetAllMocks()
  campaign = { id, name: 'Synthetic', message: 'Synthetic', status: 'draft', owned_by: ownerId,
    list_id: 'contact-list', prospect_list_id: null }
  listOwner = ownerId; missingList = false; rejectQuery = undefined; pending = '2'; processed = '0'; updated = [{ id }]
  mocks.auth.mockResolvedValue({ ok: true, user: { user_id: ownerId, role: 'operator', sectors: ['send'] } })
  mocks.seed.mockResolvedValue({ total: 2, queued: 2 })
  mocks.prospects.mockResolvedValue({ total: 2, queued: 2 })
  mocks.lock.mockResolvedValue('synthetic-lock')
  mocks.single.mockResolvedValue(undefined); mocks.multi.mockResolvedValue(undefined)
  mocks.summary.mockResolvedValue({ total: 2, queued: 0 })
  mocks.query.mockImplementation(async (sql: string) => {
    if (rejectQuery && sql.includes(rejectQuery)) throw new Error('synthetic database failure')
    if (sql.includes('SELECT c.*') || sql.includes('SELECT * FROM campaigns')) return [campaign]
    if (/SELECT owned_by FROM (contact_lists|prospect_lists)/.test(sql)) return missingList ? [] : [{ owned_by: listOwner }]
    if (sql.includes('JOIN blacklist bl')) return [{ count: '0' }]
    if (sql.includes('INSERT INTO campaign_recipients')) return []
    if (sql.includes('COUNT(*)::text AS total')) return [{ total: '2', sent: processed }]
    if (sql.includes("FILTER (WHERE status IN ('sent','failed','skipped'))")) return [{ count: processed }]
    if (sql.includes('FROM campaign_recipients') && sql.includes('COUNT(*)')) return [{ count: pending }]
    if (sql.includes('UPDATE campaigns')) return updated
    if (sql.includes('UPDATE prospect_lists')) return []
    if (sql.includes('total_in_list')) return [{ total_in_list: '0' }]
    throw new Error(`Unexpected synthetic query: ${sql}`)
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in route tests') }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe.each(routes)('%s audience guard uses the actual ownership helper', (_name, route) => {
  it.each(['contact', 'prospect'])('rejects a transferred %s list before seed or lock', async source => {
    if (source === 'prospect') { campaign.list_id = null; campaign.prospect_list_id = 'prospect-list' }
    listOwner = 'different-owner'
    expect((await invoke(route)).status).toBe(403)
    expect(mocks.seed).not.toHaveBeenCalled(); expect(mocks.prospects).not.toHaveBeenCalled()
    expect(mocks.lock).not.toHaveBeenCalled(); expect(mocks.single).not.toHaveBeenCalled(); expect(mocks.multi).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls).toHaveLength(2)
  })
  it.each(['neither', 'both'])('rejects invalid audience: %s', async source => {
    if (source === 'neither') campaign.list_id = null
    else campaign.prospect_list_id = 'prospect-list'
    expect((await invoke(route)).status).toBe(400)
    expect(mocks.query.mock.calls).toHaveLength(1)
  })
  it('reports a removed list as 404', async () => {
    missingList = true
    expect((await invoke(route)).status).toBe(404)
    expect(mocks.lock).not.toHaveBeenCalled()
  })
  it('fails closed with 500 when audience ownership cannot be read', async () => {
    rejectQuery = 'SELECT owned_by'
    expect((await invoke(route)).status).toBe(500)
    expect(mocks.lock).not.toHaveBeenCalled(); expect(mocks.single).not.toHaveBeenCalled(); expect(mocks.multi).not.toHaveBeenCalled()
  })
  it('allows the owner of a prospect list', async () => {
    campaign.list_id = null; campaign.prospect_list_id = 'prospect-list'
    expect((await invoke(route)).status).toBe(200)
    expect(mocks.query.mock.calls[1][0]).toContain('FROM prospect_lists')
  })
})

describe('query and seed failures must not become empty-list or completion results', () => {
  it.each(['draft', 'running'])('send returns 500 on seed failure even while %s', async status => {
    campaign.status = status; rejectQuery = 'INSERT INTO campaign_recipients'
    expect((await invoke(send)).status).toBe(500)
    expect(mocks.single).not.toHaveBeenCalled()
  })
  it.each(['draft', 'running'])('dispatch returns 500 on seed failure even while %s', async status => {
    campaign.status = status; mocks.seed.mockRejectedValueOnce(new Error('synthetic seed failed'))
    expect((await invoke(dispatch)).status).toBe(500)
    expect(mocks.lock).not.toHaveBeenCalled(); expect(mocks.multi).not.toHaveBeenCalled()
  })
  it.each([['send', send], ['process', processRoute]] as const)('%s count failure returns 500', async (_name, route) => {
    rejectQuery = "AND status IN ('pending','sending')"
    expect((await invoke(route)).status).toBe(500)
    expect(mocks.lock).not.toHaveBeenCalled(); expect(mocks.single).not.toHaveBeenCalled(); expect(mocks.multi).not.toHaveBeenCalled()
  })
  it.each([['send', send], ['dispatch', dispatch]] as const)('%s totals failure returns 500', async (_name, route) => {
    pending = '0'; mocks.seed.mockResolvedValueOnce({ total: 2, queued: 0 })
    rejectQuery = "FILTER (WHERE status IN ('sent','failed','skipped'))"
    expect((await invoke(route)).status).toBe(500)
    expect(mocks.lock).not.toHaveBeenCalled(); expect(mocks.single).not.toHaveBeenCalled()
  })
  it('dispatch eligibility failure returns 500', async () => {
    mocks.seed.mockResolvedValueOnce({ total: 0, queued: 0 })
    mocks.breakdown.mockRejectedValueOnce(new Error('synthetic diagnostic failed'))
    expect((await invoke(dispatch)).status).toBe(500)
  })
  it('resume summary failure returns 500 instead of a false success', async () => {
    pending = '0'; mocks.summary.mockRejectedValueOnce(new Error('synthetic summary failed'))
    expect((await invoke(processRoute)).status).toBe(500)
    expect(mocks.lock).not.toHaveBeenCalled()
  })
  it.each([['send', send], ['dispatch', dispatch]] as const)('%s completion protects locks and concurrent work', async (_name, route) => {
    campaign.status = 'paused'; pending = '0'; processed = '2'; updated = []
    mocks.seed.mockResolvedValueOnce({ total: 2, queued: 0 })
    const response = await invoke(route)
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('estado cambió')
    const completion = mocks.query.mock.calls.find(([sql]) => sql.includes("SET status = 'completed'"))!
    expect(completion[0]).toContain('status = $2::campaign_status')
    expect(completion[0]).toContain('processor_locked_at IS NULL AND processor_lock_token IS NULL')
    expect(completion[0]).toContain('AND NOT EXISTS')
    expect(completion[1]).toEqual([id, 'paused', ownerId])
    expect(mocks.single).not.toHaveBeenCalled(); expect(mocks.multi).not.toHaveBeenCalled()
  })
})

describe.each(routes)('%s crash recovery respects lock ownership', (_name, route) => {
  it('never clears a replacement token and reports skipped cleanup', async () => {
    const failedProcessor = route === send ? mocks.single : mocks.multi
    failedProcessor.mockImplementationOnce(async () => { updated = []; throw new Error('synthetic processor failure') })
    expect((await invoke(route)).status).toBe(200)
    await new Promise(resolve => setImmediate(resolve))
    const cleanup = mocks.query.mock.calls.find(([sql]) => sql.includes("pause_reason = 'systemic_error'"))!
    expect(cleanup[0]).toContain('processor_lock_token = $2')
    expect(cleanup[1][0]).toBe(id)
    expect(cleanup[1][1]).toBe(route === send ? mocks.single.mock.calls[0][1] : 'synthetic-lock')
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'processor.crash.cleanup.skipped' }))
  })
  it('reports failure to persist cleanup', async () => {
    const failedProcessor = route === send ? mocks.single : mocks.multi
    failedProcessor.mockImplementationOnce(async () => {
      rejectQuery = "pause_reason = 'systemic_error'"
      throw new Error('synthetic processor failure')
    })
    expect((await invoke(route)).status).toBe(200)
    await new Promise(resolve => setImmediate(resolve))
    expect(mocks.critical).toHaveBeenCalledWith(expect.objectContaining({ event: 'processor.crash.cleanup.failed' }))
  })
})
