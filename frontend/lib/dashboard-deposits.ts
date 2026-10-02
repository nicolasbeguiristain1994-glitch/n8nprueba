import { financialLedgerSql } from './dashboard-financial-ledger'
import { getPlatformFilterSql, SYNC_PLATFORMS, type Platform, type SyncPlatform } from './casino-agents'
import { dashboardAgentSql, DASHBOARD_TIMEZONE, movementDateSql, movementPeriodSql } from './dashboard-scope'

export interface DepositBucket { key: number; count: number; amount: string }
export interface DepositAnalytics {
  total: { count: number; amount: string }
  platforms: { platform: SyncPlatform; count: number; amount: string; percentage: string }[]
  hours: DepositBucket[]
  monthDays: DepositBucket[]
  weekdays: DepositBucket[]
  withoutTime: { count: number; amount: string }
  timezone: string
}
export interface DepositAggregateRow {
  dimension: 'total' | 'platform' | 'hour' | 'monthDay' | 'weekday'
  key: string | null
  count: number
  amount: string
  percentage: string | null
}

/** One snapshot and one filtered ledger for all four graphs. SQL keeps decimal sums exact. */
export function depositAnalyticsSql(platform: Platform): string {
  const period = (alias: string) => `${getPlatformFilterSql(platform, alias)}
    AND ${dashboardAgentSql(platform, 3, alias)} AND ${movementPeriodSql(alias)}`
  return `WITH ledger AS (${financialLedgerSql(period)}), deposits AS MATERIALIZED (
    SELECT platform, monto, ${movementDateSql()} AS day,
      EXTRACT(HOUR FROM fecha_hora_utc AT TIME ZONE '${DASHBOARD_TIMEZONE}')::int AS hour
    FROM ledger
    WHERE tipo = 'carga' AND ${getPlatformFilterSql(platform)}
      AND ${dashboardAgentSql(platform, 3)}
      AND ${movementDateSql()} BETWEEN $1::date AND $2::date
  ), aggregated AS (
    SELECT CASE WHEN GROUPING(platform)=0 THEN 'platform'
      WHEN GROUPING(hour)=0 THEN 'hour'
      WHEN GROUPING(EXTRACT(DAY FROM day))=0 THEN 'monthDay'
      WHEN GROUPING(EXTRACT(ISODOW FROM day))=0 THEN 'weekday' ELSE 'total' END AS dimension,
      CASE WHEN GROUPING(platform)=0 THEN platform
        WHEN GROUPING(hour)=0 THEN hour::text
        WHEN GROUPING(EXTRACT(DAY FROM day))=0 THEN EXTRACT(DAY FROM day)::int::text
        WHEN GROUPING(EXTRACT(ISODOW FROM day))=0 THEN EXTRACT(ISODOW FROM day)::int::text END AS key,
      COUNT(*)::int AS count, COALESCE(SUM(monto),0) AS amount
    FROM deposits GROUP BY GROUPING SETS ((platform),(hour),(EXTRACT(DAY FROM day)),(EXTRACT(ISODOW FROM day)),())
  ) SELECT dimension,key,count,amount::text,
    CASE WHEN dimension='platform' THEN COALESCE(ROUND(100*amount / NULLIF((SELECT amount FROM aggregated WHERE dimension='total'),0),2),0)::text END AS percentage
    FROM aggregated`
}

export function depositAnalytics(rows: DepositAggregateRow[], platform: Platform): DepositAnalytics {
  const buckets = (dimension: DepositAggregateRow['dimension'], length: number, offset = 0): DepositBucket[] =>
    Array.from({ length }, (_, i) => {
      const key = i + offset
      const row = rows.find(r => r.dimension === dimension && r.key === String(key))
      return { key, count: row?.count ?? 0, amount: row?.amount ?? '0' }
    })
  const total = rows.find(r => r.dimension === 'total')
  const withoutTime = rows.find(r => r.dimension === 'hour' && r.key === null)
  return {
    total: { count: total?.count ?? 0, amount: total?.amount ?? '0' },
    platforms: (platform === 'consolidado' ? SYNC_PLATFORMS : [platform]).map(p => {
      const row = rows.find(r => r.dimension === 'platform' && r.key === p)
      return { platform: p, count: row?.count ?? 0, amount: row?.amount ?? '0', percentage: row?.percentage ?? '0' }
    }),
    hours: buckets('hour', 24), monthDays: buckets('monthDay', 31, 1), weekdays: buckets('weekday', 7, 1),
    withoutTime: { count: withoutTime?.count ?? 0, amount: withoutTime?.amount ?? '0' },
    timezone: DASHBOARD_TIMEZONE,
  }
}
