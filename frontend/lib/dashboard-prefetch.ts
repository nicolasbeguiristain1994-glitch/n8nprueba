'use client'

import { normalizedSavedFilters } from './dashboard-scope'
import { queryDateRange } from './dashboard-date-range'
import { DEFAULT_DATE_RANGE, normalizeDateRange } from '@/components/dashboard/types'

type Pending = { userId: string; query: string; expires: number; result: Promise<unknown>; controller: AbortController; timer: ReturnType<typeof setTimeout> }
let pending: Pending | undefined
const saved = (key: string, fallback: unknown) => { try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback } catch { return fallback } }

export function clearDashboardPrefetch() {
  if (pending) { clearTimeout(pending.timer); pending.controller.abort(); pending = undefined }
}

// Start the authorized API request on navigation intent, in parallel with the
// router/code download. Consume it once, only for the same user and exact scope.
export function prefetchDashboard(userId: string) {
  const { platform, agent } = normalizedSavedFilters(saved('dashboard:platform', 'consolidado'), saved('dashboard:agent', ''))
  const range = normalizeDateRange(saved('dashboard:dateRange', DEFAULT_DATE_RANGE))
  const query = new URLSearchParams({ platform, agent, ...queryDateRange(range) }).toString()
  if (pending?.userId === userId && pending.query === query && pending.expires > Date.now()) return
  clearDashboardPrefetch()
  const controller = new AbortController()
  const result = fetch(`/api/dashboard/casino?${query}`, { cache: 'no-store', signal: controller.signal })
    .then(response => response.ok ? response.json() : null).catch(() => null)
  const timer = setTimeout(clearDashboardPrefetch, 5000)
  pending = { userId, query, expires: Date.now() + 5000, result, controller, timer }
}

export function takeDashboardPrefetch(userId: string | undefined, query: URLSearchParams): Promise<unknown> | undefined {
  if (!pending || pending.userId !== userId || pending.query !== query.toString() || pending.expires <= Date.now()) return
  const entry = pending; pending = undefined; clearTimeout(entry.timer)
  // A consumed request still has a bounded lifetime, even if navigation fails.
  const deadline = setTimeout(() => entry.controller.abort(), 10_000)
  return entry.result.finally(() => clearTimeout(deadline))
}
