// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
vi.mock('@/lib/db', () => ({ query: vi.fn() }))
vi.mock('@/lib/dashboard-snapshot-query', () => ({ dashboardSnapshotQuery: (sql: string, params?: unknown[]) => query(sql, params) }))
vi.mock('@/lib/permissions', () => ({ checkPermission: vi.fn() }))
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { dashboardSnapshot } from '../dashboard-snapshot'
import { GET as agents } from '@/app/api/dashboard/casino/agents/route'
import { GET as casino } from '@/app/api/dashboard/casino/route'
import { GET as overview } from '@/app/api/dashboard/casino/overview/route'
import { GET as deposits } from '@/app/api/dashboard/casino/deposits/route'
beforeEach(() => { vi.resetAllMocks(); dashboardSnapshot.reset(); vi.stubEnv('NODE_ENV', 'production') })
afterEach(() => { dashboardSnapshot.reset(); vi.unstubAllEnvs(); vi.useRealTimers() })
const request = (params = '') => new Request('http://localhost/?platform=consolidado&from=2026-10-02&to=2026-10-08' + params)
it.each([casino, overview, deposits, agents])('checks live permissions even when financial data is already warm', async GET => {
  vi.mocked(query).mockResolvedValue([{ dashboard: { agentes: [] } }])
  expect((await GET(request())).status).toBe(200)
  expect((await GET(request())).status).toBe(200); expect(query).toHaveBeenCalledOnce()
  vi.mocked(checkPermission).mockResolvedValue(new NextResponse(null, { status: 403 }))
  expect((await GET(request())).status).toBe(403); expect(checkPermission).toHaveBeenCalledTimes(3); expect(query).toHaveBeenCalledOnce()
})
it('separates dates, platforms and normalized agents and bypasses cache on manual refresh', async () => {
  vi.mocked(query).mockResolvedValue([{ dashboard: { agentes: [{ total: 7 }] } }])
  const first = await casino(request('&agent=royal'))
  expect(first.headers.get('Cache-Control')).toBe('no-store')
  expect(await first.json()).toMatchObject({ agentes: [{ total: 7 }], updatedAt: expect.any(String) })
  await casino(request('&agent=adminroyal')); expect(query).toHaveBeenCalledOnce()
  await casino(request('&agent=bigwin')); await casino(new Request('http://localhost/?platform=zeus&from=2026-10-02&to=2026-10-08&agent=royal'))
  await casino(new Request('http://localhost/?platform=consolidado&from=2026-10-01&to=2026-10-08&agent=royal'))
  expect(query).toHaveBeenCalledTimes(4)
  vi.mocked(query).mockResolvedValue([{ dashboard: { agentes: [{ total: 8 }] } }])
  expect(await (await casino(request('&agent=royal&refresh=1'))).json()).toMatchObject({ agentes: [{ total: 8 }] })
  expect(query).toHaveBeenCalledTimes(5)
})

it('keeps fast agent cards and account details in separate caches with explicit refresh', async () => {
  vi.mocked(query).mockResolvedValue([{ dashboard: { agentes: [{ agente: 'royal', nuevos_mes: 3 }] } }])
  await agents(request()); await agents(request()); expect(query).toHaveBeenCalledTimes(1)
  await casino(request('&details=1')); await casino(request('&details=1')); expect(query).toHaveBeenCalledTimes(2)
  await casino(request()); expect(query).toHaveBeenCalledTimes(3)
  await agents(request('&refresh=1')); expect(query).toHaveBeenCalledTimes(4)
  await agents(request('&agent=royal')); expect(query).toHaveBeenCalledTimes(5)
  await agents(new Request('http://localhost/?platform=invalid')); expect(query).toHaveBeenCalledTimes(5)
})
