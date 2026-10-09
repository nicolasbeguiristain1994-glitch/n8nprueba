import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDashboard } from '../useDashboard'

beforeEach(() => { localStorage.clear(); localStorage.setItem('dashboard:autoRefresh', 'false') })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const response = (body: unknown = {}) => ({ ok: true, json: async () => body })

describe('useDashboard', () => {
  it('passes the selected dates and agent to both casino requests', async () => {
    const fetcher = vi.fn().mockResolvedValue(response())
    vi.stubGlobal('fetch', fetcher)
    const { result } = renderHook(useDashboard)
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      result.current.setPlatform('ganamos')
      result.current.setAgent('adminbtc')
      result.current.setDateRange({ preset: 'custom', from: '2026-09-22', to: '2026-09-23' })
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    for (const path of ['/api/dashboard/casino?', '/api/dashboard/casino/overview?']) {
      const call = fetcher.mock.calls.filter(([url]) => String(url).startsWith(path)).at(-1)!
      const query = new URL(String(call[0]), 'http://localhost').searchParams
      // Custom end is exclusive (23/09 00:00): the APIs receive the last included day.
      expect(Object.fromEntries(query)).toMatchObject({ platform: 'ganamos', agent: 'adminbtc', from: '2026-09-22', to: '2026-09-22' })
    }
  })
  it('queries August 1–31 for a custom Aug 1 → Sep 1 range in every date-scoped request', async () => {
    const fetcher = vi.fn().mockResolvedValue(response())
    vi.stubGlobal('fetch', fetcher)
    const { result } = renderHook(useDashboard)
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setDateRange({ preset: 'custom', from: '2026-08-01', to: '2026-09-01' }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    for (const path of ['/api/dashboard/casino?', '/api/dashboard/casino/overview?', '/api/dashboard/casino/deposits?']) {
      const call = fetcher.mock.calls.filter(([url]) => String(url).startsWith(path)).at(-1)!
      const query = new URL(String(call[0]), 'http://localhost').searchParams
      expect([query.get('from'), query.get('to')]).toEqual(['2026-08-01', '2026-08-31'])
    }
    // The stored/applied range keeps the user's exclusive end.
    expect(result.current.dateRange).toEqual({ preset: 'custom', from: '2026-08-01', to: '2026-09-01' })
  })
  it('keeps presets inclusive: the last requested day is today', async () => {
    const fetcher = vi.fn().mockResolvedValue(response())
    vi.stubGlobal('fetch', fetcher)
    const { result } = renderHook(useDashboard)
    await waitFor(() => expect(result.current.loading).toBe(false))
    const call = fetcher.mock.calls.filter(([url]) => String(url).startsWith('/api/dashboard/casino/deposits?')).at(-1)!
    const query = new URL(String(call[0]), 'http://localhost').searchParams
    expect(query.get('to')).toBe(result.current.dateRange.to)
    expect(query.get('from')).toBe(result.current.dateRange.from)
  })
  it('surfaces partial failure without marking the whole view successfully refreshed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/overview?') ? { ok: false } : response()))
    const { result } = renderHook(useDashboard)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toContain('movimientos')
    expect(result.current.data?.activity).toBeNull()
    expect(result.current.lastUpdated).toBeNull()
  })
  it('ignores a stale response after switching platforms', async () => {
    let resolveOld!: (r: ReturnType<typeof response>) => void
    const old = new Promise<ReturnType<typeof response>>(resolve => { resolveOld = resolve })
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.startsWith('/api/dashboard/casino?') && url.includes('consolidado')) return old
      return Promise.resolve(response(url.startsWith('/api/dashboard/casino?') ? { summary: { total_jugadores: 7 } } : {}))
    }))
    const { result } = renderHook(useDashboard)
    act(() => result.current.setPlatform('ganamos'))
    await waitFor(() => expect(result.current.data?.casino?.summary?.total_jugadores).toBe(7))
    await act(async () => { resolveOld(response({ summary: { total_jugadores: 999 } })); await old })
    expect(result.current.data?.casino?.summary?.total_jugadores).toBe(7)
  })
})

describe('persisted dashboard filters', () => {
  it('migrates legacy aliases in Consolidado and clears the stored agent on request', async () => {
    localStorage.setItem('dashboard:agent', JSON.stringify('adminroyal'))
    localStorage.setItem('dashboard:dateRange', JSON.stringify({preset:'30d',from:'2000-01-01',to:'2000-01-30'}))
    const fetcher=vi.fn().mockResolvedValue(response());vi.stubGlobal('fetch',fetcher)
    const {result}=renderHook(useDashboard)
    await waitFor(()=>expect(result.current.loading).toBe(false))
    expect(result.current.agent).toBe('royal');expect(result.current.dateRange.to).not.toBe('2000-01-30')
    expect(localStorage.getItem('dashboard:agent')).toBe('"royal"')
    for(const path of ['casino?','casino/overview?','casino/deposits?']) {
      expect(fetcher.mock.calls.filter(([u])=>String(u).includes(path)).at(-1)?.[0]).toContain('agent=royal')
    }
    act(()=>result.current.setAgent(''))
    await waitFor(()=>expect(result.current.loading).toBe(false))
    expect(localStorage.getItem('dashboard:agent')).toBe('""')
    expect(fetcher.mock.calls.filter(([u])=>String(u).includes('casino/deposits?')).at(-1)?.[0]).toContain('agent=&')
  })
  it('recovers from malformed saved platform, agent and date values', async () => {
    localStorage.setItem('dashboard:platform','"old-platform"');localStorage.setItem('dashboard:agent','42');localStorage.setItem('dashboard:dateRange','null')
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response()))
    const {result}=renderHook(useDashboard)
    await waitFor(()=>expect(result.current.loading).toBe(false))
    expect(result.current.platform).toBe('consolidado');expect(result.current.agent).toBe('');expect(result.current.dateRange.preset).toBe('7d')
  })
  it('turns a saved single-day custom range into that full day without an extra request', async () => {
    localStorage.setItem('dashboard:dateRange', JSON.stringify({ preset: 'custom', from: '2026-08-15', to: '2026-08-15' }))
    const fetcher = vi.fn().mockResolvedValue(response()); vi.stubGlobal('fetch', fetcher)
    const { result } = renderHook(useDashboard); await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.dateRange).toEqual({ preset: 'custom', from: '2026-08-15', to: '2026-08-16' })
    const calls = fetcher.mock.calls.filter(([u]) => String(u).startsWith('/api/dashboard/casino?'))
    expect(calls).toHaveLength(1)
    expect(String(calls[0][0])).toContain('from=2026-08-15&to=2026-08-15')
  })
  it('reports chart failures separately from periods without deposits',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.includes('/deposits?')?{ok:false}:response()))
    const {result}=renderHook(useDashboard);await waitFor(()=>expect(result.current.loading).toBe(false))
    expect(result.current.error).toContain('gráficos de depósitos');expect(result.current.data?.deposits).toBeNull()
  })
})

describe('bounded dashboard refresh',()=>{
 it('does not duplicate a request when a saved relative date is normalized',async()=>{
  localStorage.setItem('dashboard:dateRange',JSON.stringify({preset:'30d',from:'2000-01-01',to:'2000-01-30'}))
  const fetcher=vi.fn().mockResolvedValue(response());vi.stubGlobal('fetch',fetcher)
  const {result}=renderHook(useDashboard);await waitFor(()=>expect(result.current.loading).toBe(false))
  expect(fetcher.mock.calls.filter(([u])=>String(u).startsWith('/api/dashboard/casino?'))).toHaveLength(1)
  expect(fetcher.mock.calls.filter(([u])=>String(u).includes('/deposits?'))).toHaveLength(1)
 })
 it('reuses unrelated widgets when dates change and reloads them on manual refresh',async()=>{
  const fetcher=vi.fn().mockResolvedValue(response());vi.stubGlobal('fetch',fetcher)
  const {result}=renderHook(useDashboard);await waitFor(()=>expect(result.current.loading).toBe(false))
  act(()=>result.current.setDateRange({preset:'custom',from:'2026-09-01',to:'2026-09-10'}))
  await waitFor(()=>expect(result.current.loading).toBe(false))
  expect(fetcher.mock.calls.filter(([u])=>u==='/api/dashboard/crm')).toHaveLength(1)
  act(()=>result.current.refresh());await waitFor(()=>expect(result.current.loading).toBe(false))
  expect(fetcher.mock.calls.filter(([u])=>u==='/api/dashboard/crm')).toHaveLength(2)
 })
 it('shows completed finance blocks before slow account queries and retains them on timeout',async()=>{
  vi.useFakeTimers()
  try {
   vi.stubGlobal('fetch',vi.fn((url:string)=>url.startsWith('/api/dashboard/casino?')?new Promise(()=>{}):Promise.resolve(response({activity:[],total:{count:4,amount:'4.00'}}))))
   const {result}=renderHook(useDashboard)
   await act(async()=>{await vi.advanceTimersByTimeAsync(200)})
   expect(result.current.financeLoading).toBe(false);expect(result.current.data?.deposits?.total.count).toBe(4)
   expect(result.current.loading).toBe(true)
   await act(async()=>{await vi.advanceTimersByTimeAsync(30000)})
   expect(result.current.loading).toBe(false);expect(result.current.error).toContain('tardó demasiado')
   expect(result.current.data?.deposits?.total.count).toBe(4)
  }finally{vi.useRealTimers()}
 })
})

it('starts agents on entry without waiting for other blocks or the filter debounce', async () => {
 vi.useFakeTimers()
 try {
  const fetcher = vi.fn((url: string) => url.startsWith('/api/dashboard/casino?')
    ? Promise.resolve(response({ agentes: [{ agente: 'royal', total: 7 }] })) : new Promise(() => {}))
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(useDashboard)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(String(fetcher.mock.calls[0][0])).toContain('/api/dashboard/casino?')
  expect(result.current.data?.casino?.agentes[0].total).toBe(7)
  expect(result.current.activityLoading).toBe(true)
 } finally { vi.useRealTimers() }
})

it('requests fresh financial results on manual refresh', async () => {
 const fetcher = vi.fn().mockResolvedValue(response()); vi.stubGlobal('fetch', fetcher)
 const { result } = renderHook(useDashboard); await waitFor(() => expect(result.current.loading).toBe(false))
 act(() => result.current.refresh()); await waitFor(() => expect(result.current.loading).toBe(false))
 for (const path of ['casino?', 'casino/overview?', 'casino/deposits?']) {
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes(path)).at(-1)?.[0]).toContain('refresh=1')
 }
})

it('retains the visible agents during a requested fresh recalculation', async () => {
 const fetcher = vi.fn((url: string) => url.includes('refresh=1') ? new Promise(() => {})
   : Promise.resolve(response(url.startsWith('/api/dashboard/casino?') ? { agentes: [{ agente: 'royal', total: 7 }] } : {})))
 vi.stubGlobal('fetch', fetcher)
 const { result } = renderHook(useDashboard); await waitFor(() => expect(result.current.loading).toBe(false))
 act(() => result.current.refresh())
 expect(result.current.data?.casino?.agentes[0].total).toBe(7)
 expect(result.current.softLoading).toBe(true)
})
