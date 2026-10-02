// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn(), owner: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth, isCampaignOwnerOrAdmin: mocks.owner }))
vi.mock('@/lib/audit', () => ({ audit: mocks.audit }))
vi.mock('@/lib/security-log', () => ({ securityLog: vi.fn() }))
import { PATCH } from '@/app/api/campaigns/[id]/schedule/route'

const id = '22222222-2222-4222-8222-222222222222'
const user = { user_id: '11111111-1111-4111-8111-111111111111', role: 'admin' }
const body = { scheduled_at: '2035-10-03T17:30:00-03:00', expected_scheduled_at: '2035-10-02T20:30:00Z' }
const row = { owned_by: user.user_id, status: 'scheduled', started_at: null, processor_locked_at: null, processor_lock_token: null }
const run = (input: unknown = body, campaignId = id) => PATCH(new NextRequest(`http://localhost/api/campaigns/${campaignId}/schedule`, {
  method: 'PATCH', body: JSON.stringify(input), headers: { 'content-type': 'application/json' },
}), { params: Promise.resolve({ id: campaignId }) })

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED', 'true'); vi.stubEnv('CRON_SECRET', 'synthetic')
  mocks.auth.mockResolvedValue({ ok: true, user }); mocks.owner.mockReturnValue(true)
  mocks.query.mockResolvedValueOnce([row]).mockResolvedValueOnce([{ scheduled_at: new Date('2035-10-03T20:30:00Z') }])
})
afterEach(() => vi.unstubAllEnvs())

describe('campaign schedule authorization and validation', () => {
  it.each(['campaigns', 'send'])('requires %s permission before reading data', async resource => {
    mocks.auth.mockImplementation(async (_req, r) => r === resource
      ? { ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) } : { ok: true, user })
    expect((await run()).status).toBe(403); expect(mocks.query).not.toHaveBeenCalled()
  })
  it('rejects another owner', async () => {
    mocks.owner.mockReturnValue(false)
    expect((await run()).status).toBe(403); expect(mocks.query).toHaveBeenCalledTimes(1)
  })
  it.each([
    { ...body, scheduled_at: '2000-01-01T17:30:00-03:00' },
    { ...body, scheduled_at: '2035-02-30T17:30:00-03:00' },
    { ...body, scheduled_at: 'tomorrow' },
    { ...body, scheduled_at: null },
    { ...body, scheduled_at: '' },
    { scheduled_at: body.scheduled_at },
    { ...body, expected_scheduled_at: 'invalid' },
    { ...body, message: 'must not change content' },
  ])('rejects invalid or unrelated changes: %j', async input => {
    expect((await run(input)).status).toBe(400); expect(mocks.query).not.toHaveBeenCalled()
  })
  it.each(['CAMPAIGN_SCHEDULER_ENABLED', 'CRON_SECRET'])('requires enabled scheduling (%s)', async variable => {
    vi.stubEnv(variable, '')
    expect((await run()).status).toBe(409); expect(mocks.query).not.toHaveBeenCalled()
  })
  it.each([
    ...['draft', 'running', 'paused', 'completed', 'cancelled'].map(status => ({ ...row, status })),
    { ...row, started_at: new Date() }, { ...row, processor_locked_at: new Date() },
    { ...row, processor_lock_token: 'lock' },
  ])('does not reschedule a campaign that is no longer pending (%j)', async campaign => {
    mocks.query.mockReset().mockResolvedValueOnce([campaign])
    expect((await run()).status).toBe(409); expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it('handles missing and invalid IDs', async () => {
    expect((await run(body, 'bad')).status).toBe(400)
    mocks.query.mockReset().mockResolvedValueOnce([])
    expect((await run()).status).toBe(404)
  })
  it('saves normalized Argentina time and audits the previous and new schedule', async () => {
    const response = await run({ ...body, scheduled_at: '2035-10-03T17:30' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, scheduled_at: '2035-10-03T20:30:00.000Z' })
    expect(mocks.query.mock.calls[1][1]).toEqual([id, '2035-10-03T20:30:00.000Z', user.user_id, user.user_id, '2035-10-02T20:30:00.000Z'])
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ resource_id: id,
      metadata: { previous_scheduled_at: '2035-10-02T20:30:00.000Z', scheduled_at: '2035-10-03T20:30:00.000Z' } }))
  })
  it('reports a concurrent edit or start as conflict without success audit', async () => {
    mocks.query.mockReset().mockResolvedValueOnce([row]).mockResolvedValueOnce([])
    expect((await run()).status).toBe(409); expect(mocks.audit).not.toHaveBeenCalled()
  })
})
