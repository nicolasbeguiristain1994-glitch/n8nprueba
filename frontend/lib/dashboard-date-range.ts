import { shiftDate, validDateRange } from '@/lib/dashboard-format'

/**
 * Dashboard date semantics, always in Argentina time:
 * - Presets (7d, 30d, this_month, 90d, mes_actual…) cover full days; `to` is included.
 * - Custom ranges are half-open: [from 00:00, to 00:00). "01/08 → 01/09" is all of August.
 * Dashboard APIs take inclusive DATE endpoints, so every request must go through
 * queryDateRange, which turns a custom exclusive end into the previous day.
 */
export interface DashboardRangeLike {
  preset: string
  from: string  // YYYY-MM-DD
  to: string    // YYYY-MM-DD; exclusive (00:00) when preset === 'custom'
}

/** A custom range needs two real dates and a non-empty half-open interval. */
export function validCustomRange(from: string, to: string): boolean {
  return validDateRange(from, to) && from < to
}

/** Inclusive DATE endpoints accepted by the dashboard APIs. */
export function queryDateRange(range: DashboardRangeLike): { from: string; to: string } {
  return range.preset === 'custom' ? { from: range.from, to: shiftDate(range.to, -1) } : { from: range.from, to: range.to }
}

/** Exclusive end (00:00 of the day after the last included day), for seeding custom inputs. */
export function exclusiveEndDate(range: DashboardRangeLike): string {
  return range.preset === 'custom' ? range.to : shiftDate(range.to, 1)
}

export function formatDay(day: string): string {
  return day.split('-').reverse().join('/')
}

/** Unambiguous description: custom ranges show both midnights and the included days. */
export function describeDateRange(range: DashboardRangeLike): string {
  const included = queryDateRange(range)
  const days = included.from === included.to ? formatDay(included.from) : `${formatDay(included.from)} al ${formatDay(included.to)}`
  if (range.preset !== 'custom') return `${days}, días completos`
  return `${formatDay(range.from)} 00:00 → ${formatDay(range.to)} 00:00 (sin incluir ${formatDay(range.to)}) · incluye ${days}`
}
