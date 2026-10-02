import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { statisticsRange, ACTIVITY_CTE, STATS_FROM, STATS_TO } from '@/lib/statistics'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'estadisticas', 'read')
  if (!auth.ok) return auth.response

  const range = statisticsRange(req.nextUrl.searchParams)
  if (!range) return NextResponse.json({ error: 'Período inválido' }, { status: 400 })
  const { from, to } = range
  const owner = auth.user.role === 'admin' ? null : auth.user.user_id

  try {
    const rows = await query(`
      ${ACTIVITY_CTE} SELECT
        t.id, t.name, t.category, t.language, t.status,
        t.usage_count, t.last_used_at,
        COUNT(wm.id) FILTER (WHERE wm.direction = 'outbound' AND wm.status IN ('sent','delivered','read'))::int AS enviados,
        COUNT(wm.id) FILTER (WHERE wm.status = 'read')::int        AS leidos,
        COUNT(wm.id) FILTER (WHERE wm.direction = 'inbound')::int  AS respuestas,
        ROUND(100.0 * COUNT(wm.id) FILTER (WHERE wm.status = 'read' AND wm.direction = 'outbound' AND wm.status IN ('sent','delivered','read'))
          / NULLIF(COUNT(wm.id) FILTER (WHERE wm.direction = 'outbound' AND wm.status IN ('sent','delivered','read')), 0), 1) AS tasa_lectura
      FROM whatsapp_templates t
      LEFT JOIN activity wm ON wm.template_id = t.id
        AND wm.created_at >= ${STATS_FROM}
        AND wm.created_at < ${STATS_TO}
      GROUP BY t.id, t.name, t.category, t.language, t.status, t.usage_count, t.last_used_at
      ORDER BY t.usage_count DESC, t.created_at DESC
    `, [from, to, owner])
    return NextResponse.json({ templates: rows })
  } catch (e) {
    console.error('[/api/stats/templates]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
