import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAccessibleLineIds, lineVisibilityClause } from '@/lib/line-visibility'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response

  try {
    const ids = await getAccessibleLineIds(auth.user)
    const { clause, params } = lineVisibilityClause(ids, 'wl', 1)

    const rows = await query(`
      SELECT
        wl.id, wl.line_key, wl.display_name, wl.phone_number,
        wl.status, wl.is_connected,
        wl.msgs_sent_today, wl.msg_per_day,
        wl.total_sent::int, wl.total_failed::int, wl.total_delivered::int,
        ROUND(100.0 * wl.total_delivered / NULLIF(wl.total_sent, 0), 1) AS tasa_entrega,
        ROUND(100.0 * wl.total_failed    / NULLIF(wl.total_sent, 0), 1) AS tasa_error,
        wl.last_seen_at
      FROM whatsapp_lines wl
      WHERE 1=1 ${clause}
      ORDER BY wl.priority ASC, wl.total_sent DESC
    `, params)
    return NextResponse.json({ lines: rows })
  } catch (e) {
    console.error('[/api/stats/lines]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
