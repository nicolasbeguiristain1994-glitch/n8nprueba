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
    return { ok: true, json: async () => ({ activity: [{ platform: 'zeus' }], summary: { total_jugadores: 7 }, stats: { sent: 9 }, kpis: {}, tasks: [] }) }
  })
  vi.stubGlobal('fetch', fetcher)
  const { result } = renderHook(useDashboard)
  await act(async () => { await vi.advanceTimersByTimeAsync(200) })
  expect(result.current.activityLoading).toBe(false)
  expect(result.current.depositsLoading).toBe(true)
  expect(result.current.data?.casino?.summary?.total_jugadores).toBe(7)
  expect(result.current.data?.crmAvailable).toBe(true)
  expect(result.current.data?.msgs?.sent).toBe(9)
  expect(maxActive).toBe(2)
  expect(fetcher).toHaveBeenCalledTimes(5)
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
