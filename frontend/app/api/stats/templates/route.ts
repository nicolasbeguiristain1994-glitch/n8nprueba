import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response

  const from = req.nextUrl.searchParams.get('from') || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)
  const to   = req.nextUrl.searchParams.get('to')   || new Date().toISOString().slice(0, 10)

  try {
    const rows = await query(`
      SELECT
        t.id, t.name, t.category, t.language, t.status,
        t.usage_count, t.last_used_at,
        COUNT(wm.id) FILTER (WHERE wm.direction = 'outbound')::int AS enviados,
        COUNT(wm.id) FILTER (WHERE wm.status = 'read')::int        AS leidos,
        COUNT(wm.id) FILTER (WHERE wm.direction = 'inbound')::int  AS respuestas,
        ROUND(100.0 * COUNT(wm.id) FILTER (WHERE wm.status = 'read' AND wm.direction = 'outbound')
          / NULLIF(COUNT(wm.id) FILTER (WHERE wm.direction = 'outbound'), 0), 1) AS tasa_lectura
      FROM whatsapp_templates t
      LEFT JOIN whatsapp_messages wm ON wm.template_id = t.id
        AND wm.created_at >= $1::date
        AND wm.created_at <  ($2::date + INTERVAL '1 day')
      GROUP BY t.id, t.name, t.category, t.language, t.status, t.usage_count, t.last_used_at
      ORDER BY t.usage_count DESC, t.created_at DESC
    `, [from, to])
    return NextResponse.json({ templates: rows })
  } catch (e) {
    console.error('[/api/stats/templates]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
