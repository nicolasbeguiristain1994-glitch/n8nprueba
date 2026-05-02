import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response

  const from = req.nextUrl.searchParams.get('from') || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)
  const to   = req.nextUrl.searchParams.get('to')   || new Date().toISOString().slice(0, 10)
  const type = req.nextUrl.searchParams.get('type') || 'overview'

  const isAdmin = auth.user.role === 'admin'
  const ownerFilter = isAdmin ? '' : `AND c.owned_by = '${auth.user.user_id}'`

  try {
    let rows: Record<string, unknown>[] = []
    let filename = 'estadisticas'

    if (type === 'campaigns') {
      rows = await query(`
        SELECT
          c.name AS "Campaña", c.type AS "Tipo", c.status AS "Estado",
          COUNT(wm.id) FILTER (WHERE wm.direction='outbound')::int AS "Enviados",
          COUNT(wm.id) FILTER (WHERE wm.status='delivered')::int   AS "Entregados",
          COUNT(wm.id) FILTER (WHERE wm.status='read')::int        AS "Leídos",
          COUNT(wm.id) FILTER (WHERE wm.status='failed')::int      AS "Fallidos",
          ROUND(100.0 * COUNT(wm.id) FILTER (WHERE wm.status IN ('delivered','read') AND wm.direction='outbound')
            / NULLIF(COUNT(wm.id) FILTER (WHERE wm.direction='outbound'), 0), 1) AS "Tasa entrega %",
          ROUND(100.0 * COUNT(wm.id) FILTER (WHERE wm.status='read' AND wm.direction='outbound')
            / NULLIF(COUNT(wm.id) FILTER (WHERE wm.direction='outbound'), 0), 1) AS "Tasa lectura %",
          TO_CHAR(c.created_at, 'DD/MM/YYYY') AS "Fecha creación"
        FROM campaigns c
        LEFT JOIN whatsapp_messages wm ON wm.campaign_id = c.id
          AND wm.created_at >= $1::date AND wm.created_at < ($2::date + INTERVAL '1 day')
        WHERE c.created_at >= $1::date AND c.created_at < ($2::date + INTERVAL '1 day')
          ${ownerFilter}
        GROUP BY c.id, c.name, c.type, c.status, c.created_at
        ORDER BY "Enviados" DESC NULLS LAST
      `, [from, to])
      filename = `campanas_${from}_${to}`
    } else {
      rows = await query(`
        SELECT
          DATE(created_at)::text AS "Fecha",
          COUNT(*) FILTER (WHERE direction='outbound')::int AS "Enviados",
          COUNT(*) FILTER (WHERE status='delivered')::int   AS "Entregados",
          COUNT(*) FILTER (WHERE status='read')::int        AS "Leídos",
          COUNT(*) FILTER (WHERE status='failed')::int      AS "Fallidos",
          COUNT(*) FILTER (WHERE direction='inbound')::int  AS "Respuestas"
        FROM whatsapp_messages
        WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
        GROUP BY DATE(created_at)
        ORDER BY "Fecha" ASC
      `, [from, to])
      filename = `resumen_${from}_${to}`
    }

    if (rows.length === 0) {
      return NextResponse.json({ error: 'Sin datos para exportar' }, { status: 404 })
    }

    // CSV
    const headers = Object.keys(rows[0])
    const csv = [
      headers.join(','),
      ...rows.map(row =>
        headers.map(h => {
          const v = String(row[h] ?? '')
          return v.includes(',') ? `"${v}"` : v
        }).join(',')
      ),
    ].join('\n')

    return new NextResponse('\uFEFF' + csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}.csv"`,
      },
    })
  } catch (e) {
    console.error('[/api/stats/export]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
