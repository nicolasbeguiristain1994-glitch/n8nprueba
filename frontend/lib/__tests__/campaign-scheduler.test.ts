// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ query: vi.fn(), tx: vi.fn(), transaction: vi.fn(),
  seed: vi.fn(), seedProspects: vi.fn(), single: vi.fn(), multi: vi.fn(), after: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
vi.mock('@/lib/campaign-distributor', () => ({ createDispatchUnits: mocks.seed,
  createDispatchUnitsFromProspectList: mocks.seedProspects, processMultiLineInBackground: mocks.multi }))
vi.mock('@/lib/send-processor', () => ({ processInBackground: mocks.single }))
vi.mock('@/lib/campaign-logger', () => ({ clog: { error: vi.fn() } }))
vi.mock('next/server', async importOriginal => ({ ...await importOriginal<typeof import('next/server')>(), after: mocks.after }))
import { claimDueCampaigns, processScheduledCampaign, type ScheduledJob } from '@/lib/campaign-scheduler'
import { POST } from '@/app/api/cron/campaigns/route'

const id = '22222222-2222-4222-8222-222222222222'
const ownerId = '11111111-1111-4111-8111-111111111111'
const campaign = { id, name: 'synthetic schedule', status: 'scheduled', owned_by: ownerId,
  list_id: 'list', prospect_list_id: null, use_multi_line: true, scheduled_at: '2026-09-27T15:00:00Z',
  message: 'synthetic', media_url: null }
const owner = { role: 'operator', sectors: ['campaigns', 'send'], is_active: true }
const job = (): ScheduledJob => ({ campaign: { ...campaign } as ScheduledJob['campaign'], lockToken: 'synthetic-token' })
function claimable() {
  mocks.tx.mockResolvedValueOnce({ rows: [campaign] }).mockResolvedValueOnce({ rows: [owner] })
    .mockResolvedValueOnce({ rows: [{ owned_by: ownerId }] }).mockResolvedValueOnce({ rows: [{ id }] })
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED', 'true')
  vi.stubEnv('CRON_SECRET', 'synthetic-cron-secret')
  mocks.transaction.mockImplementation(fn => fn({ query: mocks.tx }))
  mocks.seed.mockResolvedValue({ total: 2, queued: 2 })
  mocks.seedProspects.mockResolvedValue({ total: 2, queued: 2 })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('atomic due claims', () => {
  it('disabled scheduler does not touch the DB', async () => {
    vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED', 'false')
    expect(await claimDueCampaigns()).toEqual({ jobs: [], blocked: 0 })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('selects due scheduled rows and claims them conditionally, never using the manual resume lock', async () => {
    claimable()
    const result = await claimDueCampaigns()
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0].lockToken).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.jobs[0].campaign.status).toBe('running')
    const select = mocks.tx.mock.calls[0][0]
    expect(select).toContain("c.status = 'scheduled' AND c.scheduled_at <= NOW()")
    expect(select).toContain('FOR UPDATE OF c SKIP LOCKED')
    const claim = mocks.tx.mock.calls[3][0]
    expect(claim).toContain("status = 'scheduled' AND scheduled_at <= NOW()")
    expect(claim).toContain('processor_locked_at IS NULL AND processor_lock_token IS NULL')
    expect(mocks.seed).not.toHaveBeenCalled()
    expect(mocks.multi).not.toHaveBeenCalled()
  })
  it.each([
    { ...owner, is_active: false },
    { ...owner, sectors: ['campaigns'] },
    { ...owner, sectors: ['send'] },
    { ...owner, role: 'viewer' },
  ])('does not claim for an inactive or no-longer-authorized owner (%j)', async actor => {
    mocks.tx.mockResolvedValueOnce({ rows: [campaign] }).mockResolvedValueOnce({ rows: [actor] })
      .mockResolvedValueOnce({ rows: [{ id }] })
    expect(await claimDueCampaigns()).toEqual({ jobs: [], blocked: 1 })
    expect(mocks.tx).toHaveBeenCalledTimes(3)
    expect(mocks.tx.mock.calls[2][0]).toContain("SET status = 'paused', pause_reason = 'config_missing'")
  })
  it.each(['contact_lists', 'prospect_lists'])('pauses instead of claiming after a %s list changes owner', async table => {
    const candidate = table === 'contact_lists' ? campaign : { ...campaign, list_id: null, prospect_list_id: 'prospect-list' }
    mocks.tx.mockResolvedValueOnce({ rows: [candidate] }).mockResolvedValueOnce({ rows: [owner] })
      .mockResolvedValueOnce({ rows: [{ owned_by: 'other' }] }).mockResolvedValueOnce({ rows: [{ id }] })
    expect(await claimDueCampaigns()).toEqual({ jobs: [], blocked: 1 })
    expect(mocks.tx.mock.calls[2][0]).toContain(`FROM ${table}`)
    expect(mocks.tx.mock.calls[3][0]).toContain("status = 'scheduled' AND scheduled_at <= NOW()")
    expect(mocks.tx.mock.calls[3][0]).toContain('processor_locked_at IS NULL AND processor_lock_token IS NULL')
  })
  it('pauses an invalid first batch so a later valid campaign is eligible on the next tick', async () => {
    const pending = Array.from({ length: 11 }, (_, i) => ({ ...campaign, id: `synthetic-${i}`, invalid: i < 10 }))
    mocks.tx.mockImplementation(async (sql: string, params?: string[]) => {
      if (sql.includes('SELECT c.*')) return { rows: pending.filter(row => row.status === 'scheduled').slice(0, 10) }
      if (sql.includes('FROM users')) {
        const current = pending.find(row => row.status === 'scheduled')
        return { rows: [{ ...owner, is_active: !current?.invalid }] }
      }
      if (sql.includes('FROM contact_lists')) return { rows: [{ owned_by: ownerId }] }
      if (sql.includes('UPDATE campaigns')) {
        const current = pending.find(row => row.id === params?.[0] && row.status === 'scheduled')
        if (!current) return { rows: [] }
        current.status = sql.includes("SET status = 'paused'") ? 'paused' : 'running'
        return { rows: [{ id: current.id }] }
      }
      throw new Error('Unexpected synthetic query')
    })
    expect(await claimDueCampaigns()).toEqual({ jobs: [], blocked: 10 })
    expect(pending.filter(row => row.status === 'paused')).toHaveLength(10)
    const later = await claimDueCampaigns()
    expect(later.jobs.map(item => item.campaign.id)).toEqual(['synthetic-10'])
    expect(later.blocked).toBe(0)
  })
  it('a cancellation or competing claim that fails the CAS produces no job', async () => {
    mocks.tx.mockResolvedValueOnce({ rows: [campaign] }).mockResolvedValueOnce({ rows: [owner] })
      .mockResolvedValueOnce({ rows: [{ owned_by: ownerId }] }).mockResolvedValueOnce({ rows: [] })
    expect((await claimDueCampaigns()).jobs).toEqual([])
    expect(mocks.single).not.toHaveBeenCalled()
  })
  it('no due campaigns produces no provider work', async () => {
    mocks.tx.mockResolvedValueOnce({ rows: [] })
    expect(await claimDueCampaigns()).toEqual({ jobs: [], blocked: 0 })
    expect(mocks.seed).not.toHaveBeenCalled()
  })
})

describe('scheduled processors respect cancellation and token ownership', () => {
  it('a cancelled claim is released without seeding or sending and cannot be revived', async () => {
    mocks.query.mockResolvedValueOnce([{ ...owner, status: 'cancelled', processor_lock_token: 'synthetic-token' }])
      .mockResolvedValueOnce([])
    await processScheduledCampaign(job())
    expect(mocks.seed).not.toHaveBeenCalled()
    expect(mocks.multi).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls[1][0]).toContain("CASE WHEN status = 'running' THEN 'paused' ELSE status END")
  })
  it('a different lock owner is never touched', async () => {
    mocks.query.mockResolvedValueOnce([{ ...owner, status: 'running', processor_lock_token: 'other-token' }])
    await processScheduledCampaign(job())
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.multi).not.toHaveBeenCalled()
  })
  it('cancellation during seeding prevents processor start', async () => {
    mocks.query.mockResolvedValueOnce([{ ...owner, status: 'running', processor_lock_token: 'synthetic-token' }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await processScheduledCampaign(job())
    expect(mocks.seed).toHaveBeenCalledWith(id, 'list')
    expect(mocks.multi).not.toHaveBeenCalled()
  })
  it.each([true, false])('uses the existing processor matching use_multi_line=%s', async multi => {
    const selected = job(); selected.campaign.use_multi_line = multi
    mocks.query.mockResolvedValueOnce([{ ...owner, status: 'running', processor_lock_token: selected.lockToken }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([owner])
    await processScheduledCampaign(selected)
    expect(multi ? mocks.multi : mocks.single).toHaveBeenCalledTimes(1)
    expect(multi ? mocks.single : mocks.multi).not.toHaveBeenCalled()
  })
  it('pauses only its own claim if seeding fails', async () => {
    mocks.query.mockResolvedValueOnce([{ ...owner, status: 'running', processor_lock_token: 'synthetic-token' }])
      .mockResolvedValueOnce([])
    mocks.seed.mockRejectedValueOnce(new Error('synthetic seed failure'))
    await processScheduledCampaign(job())
    expect(mocks.query.mock.calls[1][1]).toEqual([id, 'synthetic-token', 'systemic_error'])
    expect(mocks.multi).not.toHaveBeenCalled()
  })
  it('rechecks owner permission revoked during seeding before starting any processor', async () => {
    mocks.query.mockResolvedValueOnce([{ ...owner, status: 'running', processor_lock_token: 'synthetic-token' }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...owner, sectors: ['campaigns'] }]).mockResolvedValueOnce([])
    await processScheduledCampaign(job())
    expect(mocks.seed).toHaveBeenCalledTimes(1)
    expect(mocks.multi).not.toHaveBeenCalled()
    expect(mocks.single).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls[3][1]).toEqual([id, 'synthetic-token', 'config_missing'])
  })
})

describe('cron endpoint', () => {
  const req = (secret?: string) => new NextRequest('http://localhost/api/cron/campaigns', {
    method: 'POST', headers: secret === undefined ? {} : { 'x-cron-secret': secret },
  })
  it.each([undefined, 'wrong', 'synthetic-cron-secrex'])('rejects an absent or nonmatching secret', async secret => {
    expect((await POST(req(secret))).status).toBe(401)
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.after).not.toHaveBeenCalled()
  })
  it('disabled authenticated cron responds without touching DB or scheduling work', async () => {
    vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED', 'false')
    expect(await (await POST(req('synthetic-cron-secret'))).json()).toEqual({ ok: true, enabled: false, claimed: 0 })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('returns acknowledged claims and defers processors until after the response', async () => {
    claimable()
    const response = await POST(req('synthetic-cron-secret'))
    expect(await response.json()).toEqual({ ok: true, enabled: true, automationsEnabled: false, claimed: 1, blocked: 0 })
    expect(mocks.after).toHaveBeenCalledTimes(1)
    expect(mocks.seed).not.toHaveBeenCalled()
    expect(mocks.multi).not.toHaveBeenCalled()
  })
  it('does not claim any rows when registering deferred work fails', async () => {
    mocks.after.mockImplementationOnce(() => { throw new Error('synthetic unavailable after context') })
    expect((await POST(req('synthetic-cron-secret'))).status).toBe(500)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
