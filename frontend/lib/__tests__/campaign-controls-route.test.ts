// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ query: vi.fn(), txQuery: vi.fn(), transaction: vi.fn(),
  auth: vi.fn(), owner: vi.fn(), audit: vi.fn(), fetch: vi.fn(), prepare: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth, isCampaignOwnerOrAdmin: mocks.owner }))
vi.mock('@/lib/campaign-retry', () => ({ prepareCampaignRetry: mocks.prepare }))
vi.mock('@/lib/audit', () => ({ audit: mocks.audit }))
vi.mock('@/lib/campaign-logger', () => ({ clog: { info: vi.fn(), critical: vi.fn() } }))
import { PATCH } from '@/app/api/campaigns/[id]/route'
import { POST as retry } from '@/app/api/campaigns/[id]/retry-failed/route'
import { POST as unlock } from '@/app/api/campaigns/[id]/force-unlock/route'
import { POST as sync } from '@/app/api/campaigns/[id]/sync-status/route'

const id = '22222222-2222-4222-8222-222222222222'
const user = { user_id: '11111111-1111-4111-8111-111111111111', role: 'admin', sectors: [] }
const params = () => ({ params: Promise.resolve({ id }) })
const req = (path = '', body?: unknown) => new NextRequest(`http://localhost/api/campaigns/${id}${path}`, {
  method: body ? 'PATCH' : 'POST', ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
})
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ ok: true, user })
  mocks.owner.mockReturnValue(true)
  mocks.transaction.mockImplementation(fn => fn({ query: mocks.txQuery }))
  vi.stubGlobal('fetch', mocks.fetch)
  vi.stubEnv('EVOLUTION_GLOBAL_API_KEY', 'synthetic-key')
  vi.stubEnv('EVOLUTION_URL', 'https://default.invalid')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('campaign status controls', () => {
  it('allows closing completed priority batches without reviving or resetting recipients',async()=>{
    mocks.query.mockResolvedValueOnce([{status:'completed',owned_by:user.user_id,is_priority_broadcast:true}]).mockResolvedValueOnce([{id}])
    expect((await PATCH(req('',{status:'cancelled'}),params())).status).toBe(200)
    expect(mocks.query.mock.calls[1][1]).toEqual(['cancelled',id,user.user_id,'completed',user.user_id])
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('preserves the completed status policy for ordinary campaigns',async()=>{
    mocks.query.mockResolvedValueOnce([{status:'completed',owned_by:user.user_id,is_priority_broadcast:false}])
    expect((await PATCH(req('',{status:'cancelled'}),params())).status).toBe(409)
  })

  it.each(['completed', 'cancelled'])('does not revive %s through PATCH', async status => {
    mocks.query.mockResolvedValueOnce([{ status, owned_by: user.user_id }])
    expect((await PATCH(req('', { status: 'draft' }), params())).status).toBe(409)
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })
  it('rejects ownership before changing state', async () => {
    mocks.query.mockResolvedValueOnce([{ status: 'running', owned_by: 'another-owner' }])
    mocks.owner.mockReturnValue(false)
    expect((await PATCH(req('', { status: 'paused' }), params())).status).toBe(403)
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })
  it('returns conflict when state/owner changes before conditional PATCH', async () => {
    mocks.query.mockResolvedValueOnce([{ status: 'running', owned_by: user.user_id }]).mockResolvedValueOnce([])
    expect((await PATCH(req('', { status: 'paused' }), params())).status).toBe(409)
    expect(mocks.query.mock.calls[1][1]).toEqual(['paused', id, user.user_id, 'running', user.user_id])
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it('returns scheduled campaigns to draft while clearing the schedule', async () => {
    mocks.query.mockResolvedValueOnce([{ status: 'scheduled', owned_by: user.user_id }]).mockResolvedValueOnce([{ id }])
    expect((await PATCH(req('', { status: 'draft' }), params())).status).toBe(200)
    expect(mocks.query.mock.calls[1][0]).toContain("scheduled_at = CASE WHEN $1 = 'draft' THEN NULL")
  })
  it('does not clear a newer processor lock or overwrite a concurrent terminal state', async () => {
    const token = '33333333-3333-4333-8333-333333333333'
    const lockedAt = '2026-09-27 12:00:00.123456+00'
    mocks.query.mockResolvedValueOnce([{ status: 'running', processor_lock_token: token, processor_locked_at: lockedAt }])
      .mockResolvedValueOnce([])
    expect((await unlock(req('/force-unlock'), params())).status).toBe(409)
    expect(mocks.query.mock.calls[1][1]).toEqual([id, user.user_id, 'running', token, lockedAt])
    expect(mocks.query.mock.calls[1][0]).toContain('processor_lock_token IS NOT DISTINCT FROM $4::uuid')
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})

describe('retry definite failures only', () => {
  it.each(['running', 'cancelled', 'draft', 'scheduled'])('does not reset recipients in %s', async status => {
    mocks.txQuery.mockResolvedValueOnce({ rows: [{ status, owned_by: user.user_id, has_lock: false }] })
    expect((await retry(req('/retry-failed'), params())).status).toBe(409)
    expect(mocks.txQuery).toHaveBeenCalledTimes(1)
  })
  it('waits for the processor to release even a paused campaign lock', async () => {
    mocks.txQuery.mockResolvedValueOnce({ rows: [{ status: 'paused', owned_by: user.user_id, has_lock: true }] })
    expect((await retry(req('/retry-failed'), params())).status).toBe(409)
    expect(mocks.txQuery).toHaveBeenCalledTimes(1)
  })
  it('returns conflict when no recipient is eligible for retry', async () => {
    mocks.txQuery.mockResolvedValueOnce({ rows: [{ status: 'completed', owned_by: user.user_id, has_lock: false }] })
    mocks.prepare.mockResolvedValue(0)
    expect((await retry(req('/retry-failed'), params())).status).toBe(409)
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ query: mocks.txQuery }), id)
    expect(mocks.txQuery).toHaveBeenCalledTimes(1)
  })
  it('locks campaign and resets counters/state in the same transaction', async () => {
    mocks.txQuery.mockResolvedValueOnce({ rows: [{ status: 'completed', owned_by: user.user_id, has_lock: false }] })
      .mockResolvedValueOnce({ rows: [] })
    mocks.prepare.mockResolvedValue(2)
    const response = await retry(req('/retry-failed'), params())
    expect(await response.json()).toEqual({ ok: true, reset_count: 2 })
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.txQuery.mock.calls[0][0]).toContain('FOR UPDATE')
    expect(mocks.txQuery.mock.calls[1][0]).toContain('completed_at = NULL')
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('propagates a state-write failure out of the transaction without success/audit', async () => {
    mocks.txQuery.mockResolvedValueOnce({ rows: [{ status: 'completed', owned_by: user.user_id, has_lock: false }] })
      .mockRejectedValueOnce(new Error('synthetic rollback'))
    mocks.prepare.mockResolvedValue(2)
    expect((await retry(req('/retry-failed'), params())).status).toBe(500)
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})

describe('ACK sync authorization and line provenance', () => {
  const message = (mid: string, instance: string | null, overrides = {}) => ({
    id: mid, evolution_message_id: `provider-${mid}`, status: 'sent',
    evolution_instance: instance, evolution_url: `https://${instance || 'missing'}.invalid`,
    line_type: 'evolution', ...overrides,
  })
  const ack = (mid: string, status: string) => Response.json({ messages: { records: [
    { key: { id: `provider-${mid}` }, MessageUpdate: [{ status }] },
  ] } })
  it('requires update permission before any lookup', async () => {
    mocks.auth.mockResolvedValueOnce({ ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await sync(req('/sync-status'), params())).status).toBe(403)
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), 'campaigns', 'update')
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('does not query provider or messages for another owner', async () => {
    mocks.query.mockResolvedValueOnce([{ owned_by: 'someone-else' }]); mocks.owner.mockReturnValue(false)
    expect((await sync(req('/sync-status'), params())).status).toBe(403)
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('uses each recorded instance and skips Cloud/unassigned messages', async () => {
    mocks.query.mockResolvedValueOnce([{ owned_by: user.user_id }]).mockResolvedValueOnce([
      message('a', 'line-a'), message('b', 'line-b'), message('c', null), message('d', 'cloud-line', { line_type: 'cloud' }),
    ]).mockResolvedValue([{ id: 'updated' }])
    mocks.fetch.mockResolvedValueOnce(ack('a', 'DELIVERY_ACK')).mockResolvedValueOnce(ack('b', 'READ'))
    const result = await sync(req('/sync-status'), params())
    expect(await result.json()).toEqual({ synced: 2, total: 4, skipped: 2 })
    expect(mocks.fetch.mock.calls.map(call => call[0])).toEqual([
      'https://line-a.invalid/chat/findMessages/line-a', 'https://line-b.invalid/chat/findMessages/line-b',
    ])
  })
  it('ignores mismatched provider IDs and lower ACKs', async () => {
    mocks.query.mockResolvedValueOnce([{ owned_by: user.user_id }]).mockResolvedValueOnce([
      message('a', 'line-a'), message('b', 'line-b', { status: 'delivered' }),
    ])
    mocks.fetch.mockResolvedValueOnce(ack('different', 'READ')).mockResolvedValueOnce(ack('b', 'SERVER_ACK'))
    expect(await (await sync(req('/sync-status'), params())).json()).toMatchObject({ synced: 0 })
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })
  it('a concurrent higher ACK is not overwritten or counted as changed', async () => {
    mocks.query.mockResolvedValueOnce([{ owned_by: user.user_id }]).mockResolvedValueOnce([message('a', 'line-a')])
      .mockResolvedValueOnce([])
    mocks.fetch.mockResolvedValueOnce(ack('a', 'DELIVERY_ACK'))
    expect(await (await sync(req('/sync-status'), params())).json()).toMatchObject({ synced: 0 })
    expect(mocks.query.mock.calls[2][0]).toContain("WHEN 'delivered' THEN 2 ELSE 3 END < $4")
  })
})
