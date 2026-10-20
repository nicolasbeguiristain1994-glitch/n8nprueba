// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn(), owner: vi.fn(), state: vi.fn(), review: vi.fn(), audit: vi.fn(), refresh: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth, isCampaignOwnerOrAdmin: mocks.owner }))
vi.mock('@/lib/audit', () => ({ audit: mocks.audit }))
vi.mock('@/lib/cloud-api/meta-risk-refresh', () => ({ refreshCampaignMetaRisk: mocks.refresh }))
vi.mock('@/lib/campaign-risk', () => ({
  getCampaignRiskState: mocks.state, reviewCampaignRisk: mocks.review,
  CampaignRiskError: class extends Error { status = 409; code = 'CAMPAIGN_RISK_BLOCKED' },
}))
import { CampaignRiskError } from '@/lib/campaign-risk'
import { GET, POST } from '@/app/api/campaigns/[id]/risk/route'

const id = '11111111-1111-4111-8111-111111111111'
const incidentId = '22222222-2222-4222-8222-222222222222'
const user = { user_id: '33333333-3333-4333-8333-333333333333', role: 'admin' }
const context = (campaignId = id) => ({ params: Promise.resolve({ id: campaignId }) })
const req = (body?: unknown) => new NextRequest(`http://localhost/api/campaigns/${id}/risk`, {
  method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const body = { note: 'Revisé la audiencia y corregí el mensaje.', incidentIds: [incidentId] }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ ok: true, user }); mocks.owner.mockReturnValue(true)
  mocks.query.mockResolvedValue([{ owned_by: user.user_id }])
  mocks.state.mockResolvedValue({ blocked: true, incidents: [{ id: incidentId }] })
})

describe('campaign risk visibility and review', () => {
  it('returns authorized risk state without caching', async () => {
    const response = await GET(req(), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ blocked: true, incidents: [{ id: incidentId }] })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mocks.state).toHaveBeenCalledWith(id)
    expect(mocks.refresh).toHaveBeenCalledWith(id)
  })
  it('rejects another owner before exposing incident details', async () => {
    mocks.owner.mockReturnValue(false)
    expect((await GET(req(), context())).status).toBe(403)
    expect((await POST(req(body), context())).status).toBe(403)
    expect(mocks.state).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled()
  })
  it.each(['campaigns', 'send'])('requires %s permission for review', async resource => {
    mocks.auth.mockImplementation(async (_req, key) => key === resource
      ? { ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) } : { ok: true, user })
    expect((await POST(req(body), context())).status).toBe(403)
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled()
  })
  it('requires read permission even for a known incident URL', async () => {
    mocks.auth.mockResolvedValue({ ok: false, response: Response.json({}, { status: 403 }) })
    expect((await GET(req(), context())).status).toBe(403)
    expect(mocks.query).not.toHaveBeenCalled()
  })
  it('handles missing and malformed IDs', async () => {
    expect((await GET(req(), context('bad'))).status).toBe(400)
    expect(mocks.query).not.toHaveBeenCalled()
    mocks.query.mockResolvedValue([])
    expect((await GET(req(), context())).status).toBe(404)
  })
  it.each([
    { ...body, note: 'corto' }, { ...body, note: ' '.repeat(20) }, { ...body, note: 'x'.repeat(2001) },
    { ...body, incidentIds: [] }, { ...body, incidentIds: ['bad'] },
    { ...body, incidentIds: [incidentId, incidentId] }, { note: body.note },
  ])('rejects an incomplete review: %j', async input => {
    expect((await POST(req(input), context())).status).toBe(400)
    expect(mocks.review).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled()
  })
  it('records only the reviewed snapshot and never starts a campaign', async () => {
    const response = await POST(req({ ...body, note: ` ${body.note} ` }), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
    expect(mocks.review).toHaveBeenCalledWith({ campaignId: id, userId: user.user_id, ...body })
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ resource_id: id,
      metadata: { action: 'review_campaign_risk', incident_ids: [incidentId] } }))
  })
  it.each(['Hay una señal de Meta activa', 'Se detectó una nueva alerta; actualizá antes de revisar'])('returns a held/stale review as409: %s', async detail => {
    mocks.review.mockRejectedValue(new CampaignRiskError(detail))
    const response = await POST(req(body), context())
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: detail, code: 'CAMPAIGN_RISK_BLOCKED' })
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it('does not report a storage failure as a successful review', async () => {
    mocks.review.mockRejectedValue(new Error('storage unavailable'))
    expect((await POST(req(body), context())).status).toBe(500)
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it('returns the persisted hold when a Meta refresh cannot verify safety', async () => {
    mocks.refresh.mockRejectedValue(new CampaignRiskError('No se pudo verificar Meta'))
    const response = await GET(req(), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ blocked: true })
  })
})
