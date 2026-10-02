/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), snapshot: vi.fn(), send: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth }))
vi.mock('@/lib/audit', () => ({ audit: mocks.audit }))
vi.mock('@/lib/campaign-distributor', () => ({ buildTemplatePayload: vi.fn(), sendViaCloud: vi.fn(), CloudSendOutcomeUnknownError: class extends Error {} }))
vi.mock('@/lib/campaign-test-sends', async original => ({
  ...await original<typeof import('@/lib/campaign-test-sends')>(), getCampaignTestSnapshot: mocks.snapshot, sendCampaignTest: mocks.send,
}))
import { GET, POST } from '@/app/api/campaigns/[id]/test-send/route'
import { POST as register, DELETE as remove } from '@/app/api/campaign-test-recipients/route'
import { CampaignTestError } from '@/lib/campaign-test-sends'

const id = '11111111-1111-4111-8111-111111111111'
const body = { request_id: id, recipient_id: id, line_id: id }
const context = { params: Promise.resolve({ id }) }
function req(method = 'POST', payload: unknown = body) {
  return new Request('https://example.test/api/campaigns/test', { method,
    ...(method !== 'GET' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ ok: true, user: { role: 'admin', user_id: id } })
  mocks.snapshot.mockResolvedValue({ recipients: [], lines: [], attempts: [] })
  mocks.query.mockResolvedValue([{ id, first_name: 'Pablo', phone_number: '+5491112345678' }])
  mocks.send.mockResolvedValue({ id, recipient_id: id, status: 'sent' })
})
describe('campaign tests authorization and validation', () => {
  it('preserves authentication failures', async () => {
    mocks.auth.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await POST(req(), context)).status).toBe(401)
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('rejects non-admin access to listing, sending, registration and removal', async () => {
    mocks.auth.mockResolvedValue({ ok: true, user: { role: 'operator', user_id: id } })
    for (const response of [await GET(req('GET'), context), await POST(req(), context), await register(req()), await remove(req('DELETE', { id }))]) {
      expect(response.status).toBe(403)
    }
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.snapshot).not.toHaveBeenCalled()
  })
  it('requires sending permission as well as campaign management', async () => {
    mocks.auth.mockResolvedValueOnce({ ok: true, user: { role: 'admin', user_id: id } })
      .mockResolvedValueOnce({ ok: false, response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(req(), context)).status).toBe(403)
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it.each([{ ...body, phone_number: '+5491111111111' }, { ...body, bypass_frequency: true }, { ...body, request_id: 'invalid' }])(
    'does not accept arbitrary destinations or bypass flags: %j', async payload => {
      expect((await POST(req('POST', payload), context)).status).toBe(400)
      expect(mocks.send).not.toHaveBeenCalled()
    })
  it('returns a recorded test result and audits the attempt', async () => {
    expect((await POST(req(), context)).status).toBe(200)
    expect(mocks.send).toHaveBeenCalledWith(id, body, id)
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ action: 'test_send' }) }))
  })
  it('returns a meaningful conflict for unavailable lines or duplicate requests', async () => {
    mocks.send.mockRejectedValue(new CampaignTestError(409, 'Prueba en procesamiento'))
    expect((await POST(req(), context)).status).toBe(409)
  })
  it('validates registration without silently changing the country code', async () => {
    expect((await register(req('POST', { first_name: 'Pablo', phone_number: '1112345678' }))).status).toBe(400)
    expect(mocks.query).not.toHaveBeenCalled()
    expect((await register(req('POST', { first_name: 'Pablo', phone_number: '+5491112345678' }))).status).toBe(201)
    expect(mocks.query.mock.calls[0][1]).toEqual(['Pablo', '+5491112345678', id])
  })
  it('removes eligibility while preserving existing test history', async () => {
    expect((await remove(req('DELETE', { id }))).status).toBe(200)
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('SET active=false'), [id])
    expect(mocks.query.mock.calls.every(([sql]) => !sql.includes('DELETE'))).toBe(true)
  })
})
