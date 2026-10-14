import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAccessibleLineIds, lineVisibilityClause } from '@/lib/line-visibility'
import { statisticsRange, STATS_TIMEZONE } from '@/lib/statistics'
import { LINE_OUTCOMES_CTE } from '@/lib/line-statistics'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'estadisticas', 'read')
  if (!auth.ok) return auth.response
  const range = statisticsRange(req.nextUrl.searchParams)
  if (!range) return NextResponse.json({ error: 'Período inválido' }, { status: 400 })

  try {
    const ids = await getAccessibleLineIds(auth.user)
    const { clause, params } = lineVisibilityClause(ids, 'wl', 3)

    const rows = await query(`${LINE_OUTCOMES_CTE}
      SELECT
        wl.id, wl.line_key, wl.display_name, wl.phone_number,
        wl.status, wl.is_connected,
        wl.msgs_sent_today, wl.msg_per_day,
        COALESCE(t.total_sent,0) AS total_sent, COALESCE(t.total_failed,0) AS total_failed,
        COALESCE(t.total_delivered,0) AS total_delivered,
        ROUND(100.0 * t.total_delivered / NULLIF(t.total_sent+t.total_failed, 0), 1) AS tasa_entrega,
        ROUND(100.0 * t.total_failed / NULLIF(t.total_sent+t.total_failed, 0), 1) AS tasa_error,
        wl.last_seen_at
      FROM whatsapp_lines wl
      LEFT JOIN line_totals t ON t.line_id=wl.id
      WHERE 1=1 ${clause}
      ORDER BY wl.priority ASC, total_sent DESC
    `, [range.from, range.to, ...params])
    return NextResponse.json({ lines: rows, timezone: STATS_TIMEZONE })
  } catch (e) {
    console.error('[/api/stats/lines]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
