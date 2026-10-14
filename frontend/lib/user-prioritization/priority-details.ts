import type { SegmentationProfile } from '@/lib/contact-segmentation'

export const RANKING_MAX_AGE_HOURS = 36
export function isFreshCalculation(date: string | null | undefined, now = Date.now()): boolean {
  const age = now - Date.parse(date ?? '')
  return Number.isFinite(age) && age >= 0 && age <= RANKING_MAX_AGE_HOURS * 3600000
}

export interface RelativeRanking {
  percentile: number
  net: number | null
  calculatedAt: string
  platform: string
  agent: string
  status: 'fresh' | 'stale'
}
export interface PriorityExplanation {
  valueScore: number
  urgencyScore: number
  calculatedAt: string | null
  manualLevel: boolean
  profile: SegmentationProfile | null
  ranking: RelativeRanking | null
}

export function relativeRanking(row: Record<string, unknown> | null, now = Date.now()): RelativeRanking | null {
  if (!row || row.percentile == null || !Number.isFinite(Number(row.percentile)) || Number(row.percentile) < 0 || Number(row.percentile) > 100) return null
  const date = new Date(String(row.calculated_at))
  if (!Number.isFinite(date.getTime())) return null
  const calculatedAt = date.toISOString()
  return {
    percentile: Number(row.percentile), net: row.net == null ? null : Number(row.net),
    calculatedAt, platform: String(row.platform ?? ''), agent: String(row.agent ?? ''),
    status: isFreshCalculation(calculatedAt, now) ? 'fresh' : 'stale',
  }
}

export function profileQuality(profile: SegmentationProfile | null): string {
  if (!profile) return 'Sin historial vinculado'
  if (profile.estimated) return 'Historial estimado'
  if (profile.partial_history) return 'Historial parcial'
  return 'Movimientos registrados'
}

// Only observed, current windows can break a score tie. A partial or stale
// history must not be compared to a complete 90/30-day window as if equivalent.
export function recentPriorityOrderSQL(alias = 'c'): string {
  const p = `${alias}.segmentation_profile`
  const valid = `(${p} IS NOT NULL AND NOT COALESCE((${p}->>'estimated')::boolean,true)
    AND NOT COALESCE((${p}->>'partial_history')::boolean,true)
    AND (${p}->>'calculated_at')::timestamptz BETWEEN NOW()-INTERVAL '36 hours' AND NOW())`
  return ['amount_90d','deposits_90d','amount_30d','deposits_30d']
    .map(field => `CASE WHEN ${valid} THEN (${p}->>'${field}')::numeric END DESC NULLS LAST`).join(', ')
}
