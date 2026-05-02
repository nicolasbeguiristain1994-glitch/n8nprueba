import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response

  const from     = req.nextUrl.searchParams.get('from') || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)
  const to       = req.nextUrl.searchParams.get('to')   || new Date().toISOString().slice(0, 10)
  const status   = req.nextUrl.searchParams.get('status') || ''
  const q        = req.nextUrl.searchParams.get('q') || ''
  const detailId = req.nextUrl.searchParams.get('id') || ''

  const isAdmin = auth.user.role === 'admin'
  const ownerFilter = isAdmin ? '' : `AND c.owned_by = '${auth.user.user_id}'`

  try {
    // Detalle de una campaña específica
    if (detailId) {
      const [kpisRows, seriesRows] = await Promise.all([
        query(`
          SELECT
            COUNT(*) FILTER (WHERE direction = 'outbound')::int AS enviados,
            COUNT(*) FILTER (WHERE status = 'delivered')::int   AS entregados,
            COUNT(*) FILTER (WHERE status = 'read')::int        AS leidos,
            COUNT(*) FILTER (WHERE status = 'failed')::int      AS fallidos,
            COUNT(*) FILTER (WHERE direction = 'inbound')::int  AS respuestas,
            ROUND(100.0 * COUNT(*) FILTER (WHERE status IN ('delivered','read') AND direction='outbound')
              / NULLIF(COUNT(*) FILTER (WHERE direction='outbound'), 0), 1) AS tasa_entrega,
            ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'read' AND direction='outbound')
              / NULLIF(COUNT(*) FILTER (WHERE direction='outbound'), 0), 1) AS tasa_lectura
          FROM whatsapp_messages
          WHERE campaign_id = $1
        `, [detailId]),
        query(`
          SELECT
            DATE(created_at)::text AS dia,
            COUNT(*) FILTER (WHERE direction='outbound')::int AS enviados,
            COUNT(*) FILTER (WHERE status='delivered')::int   AS entregados,
            COUNT(*) FILTER (WHERE status='read')::int        AS leidos
          FROM whatsapp_messages
          WHERE campaign_id = $1
          GROUP BY DATE(created_at)
          ORDER BY dia ASC
        `, [detailId]),
      ])
      return NextResponse.json({ kpis: kpisRows[0] ?? {}, series: seriesRows })
    }

    // Lista de campañas con métricas
    const rows = await query(`
      SELECT
        c.id, c.name, c.type, c.status,
        c.created_at, c.completed_at,
        COUNT(wm.id) FILTER (WHERE wm.direction = 'outbound')::int          AS enviados,
        COUNT(wm.id) FILTER (WHERE wm.status = 'delivered')::int             AS entregados,
        COUNT(wm.id) FILTER (WHERE wm.status = 'read')::int                  AS leidos,
        COUNT(wm.id) FILTER (WHERE wm.status = 'failed')::int                AS fallidos,
        COUNT(wm.id) FILTER (WHERE wm.direction = 'inbound')::int            AS respuestas,
        ROUND(100.0 * COUNT(wm.id) FILTER (WHERE wm.status IN ('delivered','read') AND wm.direction='outbound')
          / NULLIF(COUNT(wm.id) FILTER (WHERE wm.direction='outbound'), 0), 1) AS tasa_entrega,
        ROUND(100.0 * COUNT(wm.id) FILTER (WHERE wm.status = 'read' AND wm.direction='outbound')
          / NULLIF(COUNT(wm.id) FILTER (WHERE wm.direction='outbound'), 0), 1) AS tasa_lectura
      FROM campaigns c
      LEFT JOIN whatsapp_messages wm ON wm.campaign_id = c.id
        AND wm.created_at >= $1::date
        AND wm.created_at <  ($2::date + INTERVAL '1 day')
      WHERE c.created_at >= $1::date
        AND c.created_at <  ($2::date + INTERVAL '1 day')
        AND ($3 = '' OR c.status = $3)
        AND ($4 = '' OR c.name ILIKE $5)
        ${ownerFilter}
      GROUP BY c.id, c.name, c.type, c.status, c.created_at, c.completed_at
      ORDER BY enviados DESC NULLS LAST, c.created_at DESC
      LIMIT 100
    `, [from, to, status, q, q ? `%${q}%` : ''])

    return NextResponse.json({ campaigns: rows })
  } catch (e) {
    console.error('[/api/stats/campaigns]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
