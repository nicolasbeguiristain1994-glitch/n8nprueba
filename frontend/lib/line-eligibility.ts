/**
 * Single source of truth for campaign-eligible line criteria.
 * Used by: GET /api/lines, GET /api/lines/health, getEligibleLines()
 *
 * Criteria (all must be true):
 *   - status = 'active'
 *   - is_connected = true
 *   - sending_enabled = true (admin kill switch)
 *   - msgs_sent_hour < msg_per_hour (hourly rate limit)
 *   - msgs_sent_today < msg_per_day (daily rate limit)
 *   - allowed_types IS NULL OR includes 'campaign'
 *
 * @param tableAlias - Optional SQL table alias prefix (e.g. 'l' → 'l.status = ...')
 */
export function lineEligibleExpr(tableAlias?: string): string {
  const p = tableAlias ? `${tableAlias}.` : ''
  return `(${p}status = 'active'
    AND ${p}is_connected = true
    AND ${p}sending_enabled = true
    AND ${p}msgs_sent_hour < ${p}msg_per_hour
    AND ${p}msgs_sent_today < ${p}msg_per_day
    AND (${p}allowed_types IS NULL OR ${p}allowed_types @> '["campaign"]'::jsonb))`
}
