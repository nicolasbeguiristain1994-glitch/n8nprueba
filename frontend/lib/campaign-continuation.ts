import { LINE_VOLUME_TIME_ZONE } from '@/lib/line-volume-policy'

/** SQL expressions below are internal identifiers/parameters, never user input.
 * Capacity becoming available is only a lower bound: continue at the campaign's
 * original local clock time, on the first date that satisfies that bound.
 * Keep calendar arithmetic in Argentina time, independent of the DB session TZ.
 */
export function campaignContinuationAtSql(anchor: string, notBefore: string): string {
  return `(SELECT (slot.local_at + CASE
      WHEN slot.local_at AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}' < (${notBefore})
      THEN INTERVAL '1 day' ELSE INTERVAL '0 days' END) AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}'
    FROM (SELECT ((${notBefore}) AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}')::date
      + ((${anchor}) AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}')::time AS local_at) slot)`
}

export function campaignLocalMidnightSql(now = 'NOW()', tomorrow = false): string {
  return `(((${now}) AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}')::date${tomorrow ? ' + 1' : ''})::timestamp AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}'`
}

/** Also fences old midnight waits and overdue work after a restart: a new local
 * day must reach the original campaign hour before automatic continuation.
 */
export function campaignBudgetDueSql(alias = '', now = 'NOW()'): string {
  const a = alias ? `${alias}.` : ''
  const anchor = `COALESCE(${a}scheduled_at, ${a}started_at, ${a}budget_resume_at)`
  const earliest = `GREATEST(${a}budget_resume_at, ${campaignLocalMidnightSql(now)})`
  return `${a}budget_resume_at <= ${now} AND ${campaignContinuationAtSql(anchor, earliest)} <= ${now}`
}
