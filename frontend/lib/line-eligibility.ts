/**
 * Single source of truth for Evolution-campaign-eligible line criteria.
 * Used by: GET /api/lines, GET /api/lines/health, getEligibleLines()
 *
 * Criteria (all must be true):
 *   - line_type = 'evolution'   ← cloud lines are excluded from Evolution senders
 *   - status = 'active'
 *   - is_connected = true
 *   - sending_enabled = true (admin kill switch)
 *   - msgs_sent_hour < msg_per_hour (hourly rate limit)
 *   - msgs_sent_today < msg_per_day (daily rate limit)
 *   - allowed_types IS NULL OR includes 'campaign'
 *
 * NOTE: Cloud API lines (line_type = 'cloud') are intentionally excluded because
 * they have NULL evolution_instance / evolution_url and cannot be used with the
 * Evolution send path. When Cloud API campaign sending is implemented, a separate
 * eligibility expression should be introduced for that path.
 *
 * @param tableAlias - Optional SQL table alias prefix (e.g. 'l' → 'l.status = ...')
 */
export function lineEligibleExpr(tableAlias?: string): string {
  const p = tableAlias ? `${tableAlias}.` : ''
  return `(${p}line_type = 'evolution'
    AND ${p}status = 'active'
    AND ${p}is_connected = true
    AND ${p}sending_enabled = true
    AND ${p}msgs_sent_hour < ${p}msg_per_hour
    AND ${p}msgs_sent_today < ${p}msg_per_day
    AND (${p}allowed_types IS NULL OR ${p}allowed_types @> '["campaign"]'::jsonb))`
}
