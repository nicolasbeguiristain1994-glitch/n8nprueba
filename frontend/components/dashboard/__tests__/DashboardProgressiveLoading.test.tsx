import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDashboard } from '../useDashboard'

beforeEach(() => { localStorage.clear(); localStorage.setItem('dashboard:autoRefresh', 'false'); vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('renders the overview, accounts and auxiliary blocks while deposits are slow, with at most two requests', async () => {
  let finishDeposits!: (value: unknown) => void
  let active = 0, maxActive = 0
  const fetcher = vi.fn(async (url: string) => {
    active++; maxActive = Math.max(maxActive, active)
    if (url.includes('/deposits?')) await new Promise(resolve => { finishDeposits = resolve })
    active--
    return { ok: true, json: async () => ({ activity: [{ platform: 'zeus' }], summary: { total_jugadores: 7 }, cash_ranking: [{ platform: 'zeus', username: 'player', diferencia: '123' }], stats: { sent: 9 }, kpis: {}, tasks: [] }) }
  })
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(useDashboard)
  await act(async () => { await vi.advanceTimersByTimeAsync(200) })
  expect(result.current.activityLoading).toBe(false)
  expect(result.current.depositsLoading).toBe(true)
  expect(result.current.data?.casino?.summary?.total_jugadores).toBe(7)
  expect(result.current.data?.casino?.cash_ranking).toEqual([{ platform: 'zeus', username: 'player', diferencia: '123' }])
  expect(result.current.data?.crmAvailable).toBe(true)
  expect(result.current.data?.msgs?.sent).toBe(9)
  expect(maxActive).toBe(2)
  expect(fetcher).toHaveBeenCalledTimes(6)
  await act(async () => { finishDeposits(null) })
  expect(result.current.loading).toBe(false)
  expect(result.current.financeLoading).toBe(false)
})
it('does not launch queued requests after timeout or allow old data to overwrite new filters', async () => {
  const releases: Array<() => void> = []
  const fetcher = vi.fn(() => new Promise(resolve => releases.push(() => resolve({ ok: true, json: async () => ({ activity: [{ platform: 'old' }] }) }))))
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(useDashboard)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_200) })
  expect(result.current.loading).toBe(false)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(result.current.error).toContain('tardó demasiado')
  await act(async () => { releases.forEach(release => release()) })
  expect(result.current.data).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('shows sales and new users while the full account report is still pending', async () => {
  const summary={sales_comparison:{previous:{from:'2026-08-01',to:'2026-08-31'},rows:[{agente:'royal',amount:'150',previous_amount:'100',difference:'50',change_percentage:'50'}]},agentes:[{agente:'royal',nuevos_mes:9}]}
  let finish!: (value: unknown) => void
  const fetcher=vi.fn(async(url:string)=>{
    if(url.startsWith('/api/dashboard/casino?'))await new Promise(resolve=>{finish=resolve})
    return {ok:true,json:async()=>url.includes('/agents?')?summary:{activity:[],kpis:{},tasks:[]}}
  })
  vi.stubGlobal('fetch',fetcher)
  const {result}=renderHook(useDashboard)
  await act(async()=>{await vi.advanceTimersByTimeAsync(200)})
  expect(result.current.data?.agentSummary).toEqual(summary)
  expect(result.current.agentsLoading).toBe(false)
  expect(result.current.data?.casino).toBeNull()
  expect(result.current.loading).toBe(true)
  expect(fetcher.mock.calls[0][0]).toContain('/casino/agents?')
  expect(fetcher.mock.calls.find(([url])=>url.startsWith('/api/dashboard/casino?'))?.[0]).toContain('details=1')
  await act(async()=>{finish(null)})
  expect(result.current.data?.agentSummary).toEqual(summary)
})

it('keeps the agent cards visible when other blocks finish during a soft refresh', async () => {
  const summary={sales_comparison:{previous:{from:'2026-08-01',to:'2026-08-31'},rows:[]},agentes:[{agente:'royal',nuevos_mes:9}]}
  let finish!: (value: unknown) => void
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
    if(url.includes('/agents?')&&url.includes('refresh=1'))await new Promise(resolve=>{finish=resolve})
    return {ok:true,json:async()=>url.includes('/agents?')?summary:{activity:[],kpis:{},tasks:[]}}
  }))
  const {result}=renderHook(useDashboard)
  await act(async()=>{await vi.advanceTimersByTimeAsync(200)})
  act(()=>result.current.refresh())
  await act(async()=>{await vi.advanceTimersByTimeAsync(200)})
  expect(result.current.agentsLoading).toBe(true)
  expect(result.current.data?.agentSummary).toEqual(summary)
  await act(async()=>{finish(null)})
  expect(result.current.agentsLoading).toBe(false)
})
