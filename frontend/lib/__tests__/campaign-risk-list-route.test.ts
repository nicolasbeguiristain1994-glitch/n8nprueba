// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn(), states: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth, isOwnerOrAdmin: vi.fn() }))
vi.mock('@/lib/campaign-risk', () => ({ getCampaignRiskStates: mocks.states }))
vi.mock('@/lib/campaign-selection-resolver', () => ({ resolveCampaignSelection: vi.fn() }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/line-visibility', () => ({ getAccessibleLineIds: vi.fn() }))
vi.mock('@/lib/security-log', () => ({ securityLog: vi.fn() }))
import { GET } from '@/app/api/campaigns/route'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ ok: true, user: { role: 'operator', user_id: 'owner' } })
  mocks.query.mockResolvedValue([{ id: 'first', name: 'Primera' }, { id: 'second', name: 'Segunda' }])
  mocks.states.mockResolvedValue({ first: { blocked: true, incidents: [{ id: 'incident' }] }, second: { blocked: false, incidents: [] } })
})
it('loads protection once for only the authorized campaign list', async () => {
  const response = await GET(new NextRequest('http://localhost/api/campaigns'))
  expect(response.status).toBe(200)
  expect(mocks.query.mock.calls[0][0]).toContain('WHERE c.owned_by = $1')
  expect(mocks.query.mock.calls[0][1]).toEqual(['owner'])
  expect(mocks.states).toHaveBeenCalledExactlyOnceWith(['first', 'second'])
  expect((await response.json()).campaigns).toEqual([
    { id: 'first', name: 'Primera', risk: { blocked: true, incidents: [{ id: 'incident' }] } },
    { id: 'second', name: 'Segunda', risk: { blocked: false, incidents: [] } },
  ])
})
it('does not expose apparently safe campaign data when protection cannot be read', async () => {
  mocks.states.mockRejectedValue(new Error('risk storage unavailable'))
  const response = await GET(new NextRequest('http://localhost/api/campaigns'))
  expect(response.status).toBe(500)
  expect((await response.json()).campaigns).toBeUndefined()
})
it('denies the list before reading protection data', async () => {
  mocks.auth.mockResolvedValue({ ok: false, response: Response.json({}, { status: 403 }) })
  expect((await GET(new NextRequest('http://localhost/api/campaigns'))).status).toBe(403)
  expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.states).not.toHaveBeenCalled()
})
