import { query } from '@/lib/db'
import { ACTIVITY_CTE } from '@/lib/statistics'
import { argentinaToday, shiftDate } from '@/lib/dashboard-format'

/** Same delivered/read and retry semantics as Statistics, including Cloud messages. */
export async function dashboardMessageStats(owner: string | null) {
  const to = argentinaToday()
  const rows = await query(`${ACTIVITY_CTE}
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE direction='outbound' AND status IN ('sent','delivered','read'))::int AS sent,
      COUNT(*) FILTER (WHERE direction='outbound' AND status='failed')::int AS failed,
      COUNT(*) FILTER (WHERE direction='outbound' AND status IN ('delivered','read'))::int AS delivered,
      COUNT(*) FILTER (WHERE direction='outbound' AND status='read')::int AS read,
      COUNT(*) FILTER (WHERE direction='inbound')::int AS inbound,
      COUNT(*) FILTER (WHERE direction='outbound' AND status IN ('sent','delivered','read')
        AND created_at > NOW() - INTERVAL '24 hours')::int AS last_24h,
      COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE direction='outbound' AND status='read') /
        NULLIF(COUNT(*) FILTER (WHERE direction='outbound' AND status IN ('sent','delivered','read')),0),1),0)::float8 AS read_rate
    FROM activity`, [shiftDate(to, -29), to, owner])
  return rows[0]
}
