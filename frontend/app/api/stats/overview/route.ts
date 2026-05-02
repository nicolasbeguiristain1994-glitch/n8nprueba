import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response

  const from = req.nextUrl.searchParams.get('from') || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)
  const to   = req.nextUrl.searchParams.get('to')   || new Date().toISOString().slice(0, 10)

  // Para operadores: filtrar solo mensajes de sus contactos visibles
  const isAdmin = auth.user.role === 'admin'
  const visFilter = isAdmin ? '' : `AND wm.phone_number IN (
    SELECT c.phone_number FROM contacts c
    JOIN operator_contact_visibility ocv ON ocv.contact_id = c.id
    WHERE ocv.operator_id = '${auth.user.user_id}'
  )`

  try {
    const [kpisRows, seriesRows, distRows, topRows, campaignCountRows] = await Promise.all([
      query(`
        SELECT
          COUNT(*) FILTER (WHERE direction = 'outbound')::int                                   AS enviados,
          COUNT(*) FILTER (WHERE direction = 'inbound')::int                                    AS respuestas,
          COUNT(*) FILTER (WHERE status = 'delivered' AND direction = 'outbound')::int          AS entregados,
          COUNT(*) FILTER (WHERE status = 'read'      AND direction = 'outbound')::int          AS leidos,
          COUNT(*) FILTER (WHERE status = 'failed'    AND direction = 'outbound')::int          AS fallidos,
          ROUND(100.0 * COUNT(*) FILTER (WHERE status IN ('delivered','read') AND direction = 'outbound')
            / NULLIF(COUNT(*) FILTER (WHERE direction = 'outbound'), 0), 1)                     AS tasa_entrega,
          ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'read' AND direction = 'outbound')
            / NULLIF(COUNT(*) FILTER (WHERE direction = 'outbound'), 0), 1)                     AS tasa_lectura,
          ROUND(100.0 * COUNT(*) FILTER (WHERE direction = 'inbound')
            / NULLIF(COUNT(*) FILTER (WHERE direction = 'outbound'), 0), 1)                     AS tasa_respuesta
        FROM whatsapp_messages wm
        WHERE wm.created_at >= $1::date
          AND wm.created_at <  ($2::date + INTERVAL '1 day')
          ${visFilter}
      `, [from, to]),

      query(`
        SELECT
          DATE(wm.created_at)::text AS dia,
          COUNT(*) FILTER (WHERE direction = 'outbound')::int  AS enviados,
          COUNT(*) FILTER (WHERE status = 'delivered')::int    AS entregados,
          COUNT(*) FILTER (WHERE status = 'read')::int         AS leidos,
          COUNT(*) FILTER (WHERE direction = 'inbound')::int   AS respuestas
        FROM whatsapp_messages wm
        WHERE wm.created_at >= $1::date
          AND wm.created_at <  ($2::date + INTERVAL '1 day')
          ${visFilter}
        GROUP BY DATE(wm.created_at)
        ORDER BY dia ASC
      `, [from, to]),

      query(`
        SELECT status, COUNT(*)::int AS n
        FROM whatsapp_messages wm
        WHERE direction = 'outbound'
          AND wm.created_at >= $1::date
          AND wm.created_at <  ($2::date + INTERVAL '1 day')
          ${visFilter}
        GROUP BY status
        ORDER BY n DESC
      `, [from, to]),

      query(`
        SELECT c.id, c.name, c.type, c.status,
          COUNT(wm.id)::int AS total,
          COUNT(wm.id) FILTER (WHERE wm.status = 'read')::int AS leidos
        FROM campaigns c
        JOIN whatsapp_messages wm ON wm.campaign_id = c.id
          AND wm.direction = 'outbound'
          AND wm.created_at >= $1::date
          AND wm.created_at <  ($2::date + INTERVAL '1 day')
        GROUP BY c.id, c.name, c.type, c.status
        ORDER BY total DESC
        LIMIT 6
      `, [from, to]),

      query(`
        SELECT
          COUNT(*)::int                                               AS total,
          COUNT(*) FILTER (WHERE status = 'completed')::int          AS completadas,
          COUNT(*) FILTER (WHERE status = 'running')::int            AS activas,
          COUNT(*) FILTER (WHERE status IN ('draft','scheduled'))::int AS programadas
        FROM campaigns
        WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
      `, [from, to]),
    ])

    return NextResponse.json({
      kpis:          kpisRows[0] ?? {},
      series:        seriesRows,
      distribution:  distRows,
      topCampaigns:  topRows,
      campaignCount: campaignCountRows[0] ?? {},
    })
  } catch (e) {
    console.error('[/api/stats/overview]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
