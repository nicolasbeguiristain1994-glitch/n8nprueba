// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
const mocks = vi.hoisted(() => ({ auth: vi.fn(),scope: vi.fn(),inputs: vi.fn(),recommend: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth }))
vi.mock('@/lib/line-visibility', () => ({ getAccessibleLineIds: mocks.scope }))
vi.mock('@/lib/line-volume-data', () => ({ getLineVolumeInputs: mocks.inputs }))
vi.mock('@/lib/line-volume-policy', () => ({ LINE_VOLUME_TIME_ZONE: 'America/Argentina/Buenos_Aires',recommendLineVolume: mocks.recommend }))
import { GET } from '@/app/api/lines/recommendations/route'
const req = () => new NextRequest('https://app.test/api/lines/recommendations?lineId=hidden')
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ ok: true,user: { user_id: 'owner',role: 'operator',is_super_admin: false } })
  mocks.scope.mockResolvedValue(['visible'])
  mocks.inputs.mockResolvedValue([{ id: 'visible',now: '2026-10-20T15:00:00Z' }])
  mocks.recommend.mockReturnValue({ status: 'start',suggestedToday: 25 })
})
it('checks lines permission and returns only the scoped recommendations, without caching', async () => {
  const response = await GET(req())
  expect(mocks.auth).toHaveBeenCalledWith(expect.any(NextRequest),'lines','read')
  expect(mocks.inputs).toHaveBeenCalledWith(['visible'],expect.any(Date))
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.json()).toMatchObject({ recommendations: { visible: { status: 'start',suggestedToday: 25 } },timeZone: 'America/Argentina/Buenos_Aires' })
})
it('denies before reading visibility, history or computing recommendations', async () => {
  mocks.auth.mockResolvedValue({ ok: false,response: NextResponse.json({ error: 'Forbidden' },{ status: 403 }) })
  expect((await GET(req())).status).toBe(403)
  expect(mocks.scope).not.toHaveBeenCalled(); expect(mocks.inputs).not.toHaveBeenCalled(); expect(mocks.recommend).not.toHaveBeenCalled()
})
it('preserves the empty visibility scope and never uses a requested line ID', async () => {
  mocks.scope.mockResolvedValue([]); mocks.inputs.mockResolvedValue([])
  expect(await (await GET(req())).json()).toMatchObject({ recommendations: {} })
  expect(mocks.inputs).toHaveBeenCalledWith([],expect.any(Date)); expect(mocks.recommend).not.toHaveBeenCalled()
})
it('passes a super-admin unrestricted scope only when returned by the visibility helper', async () => {
  mocks.scope.mockResolvedValue(null)
  await GET(req())
  expect(mocks.inputs).toHaveBeenCalledWith(null,expect.any(Date))
})
it.each(['scope','inputs'] as const)('fails closed when %s is unavailable without leaking internal details', async method => {
  mocks[method].mockRejectedValue(new Error('postgres://secret-token SQL private provider'))
  const response = await GET(req())
  expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(JSON.stringify(await response.json())).not.toMatch(/secret|postgres|SQL|provider/)
  expect(mocks.recommend).not.toHaveBeenCalled()
})
