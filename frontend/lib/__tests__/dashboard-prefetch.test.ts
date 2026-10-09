import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearDashboardPrefetch, prefetchDashboard, takeDashboardPrefetch } from '../dashboard-prefetch'
let fetcher: ReturnType<typeof vi.fn>
beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-08T12:00:00Z')); fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ agentes: [7] }) }); vi.stubGlobal('fetch', fetcher) })
afterEach(() => { clearDashboardPrefetch(); vi.useRealTimers(); vi.unstubAllGlobals() })
const qs = () => new URL(String(fetcher.mock.calls[0][0]), 'http://localhost').searchParams
const take = (user: string, query: URLSearchParams) => takeDashboardPrefetch(user, query, new AbortController().signal)
it('deduplicates hover/click and consumes the request only once for the same user and filters', async () => {
 prefetchDashboard('user1'); prefetchDashboard('user1'); expect(fetcher).toHaveBeenCalledOnce()
 expect(take('user2', qs())).toBeUndefined()
 const other = qs(); other.set('agent', 'royal'); expect(take('user1', other)).toBeUndefined()
 expect(await take('user1', qs())).toEqual({ agentes: [7] })
 expect(take('user1', qs())).toBeUndefined()
})
it('matches saved aliases, exclusive custom dates and malformed saved settings', () => {
 localStorage.setItem('dashboard:agent', '"adminroyal"')
 localStorage.setItem('dashboard:dateRange', JSON.stringify({ preset: 'custom', from: '2026-08-01', to: '2026-09-01' }))
 prefetchDashboard('user1'); expect(Object.fromEntries(qs())).toEqual({ platform: 'consolidado', agent: 'royal', from: '2026-08-01', to: '2026-08-31' })
 clearDashboardPrefetch(); localStorage.setItem('dashboard:platform', 'broken json'); expect(() => prefetchDashboard('user1')).not.toThrow()
})
it('aborts and forgets data on logout, expiry and a change of user', () => {
 prefetchDashboard('user1'); const signal = fetcher.mock.calls[0][1].signal
 prefetchDashboard('user2'); expect(signal.aborted).toBe(true)
 clearDashboardPrefetch(); expect(take('user2', qs())).toBeUndefined()
 prefetchDashboard('user2'); vi.advanceTimersByTime(5001); expect(take('user2', qs())).toBeUndefined()
})
