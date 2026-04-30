import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { visibilityClause } from '@/lib/contact-visibility'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth

  // Para operadores/viewers: filtrar métricas de contactos y mensajes
  // solo al universo de contactos que tienen asignados.
  const vis = visibilityClause(user.role, user.user_id, 0)

  // Fragmento para filtrar mensajes por teléfonos de contactos visibles
  const msgVisFilter = user.role === 'admin'
    ? ''
    : `AND wm.phone_number IN (
         SELECT c.phone_number FROM contacts c
         JOIN operator_contact_visibility ocv ON ocv.contact_id = c.id
         WHERE ocv.operator_id = '${user.user_id}'
       )`

  try {
    const [stats, lines, recent, campaignStats, contactStats] = await Promise.all([
      // Estadísticas de mensajes filtradas por visibilidad
      query(`
        SELECT
          COUNT(*)                                                AS total,
          COUNT(*) FILTER (WHERE wm.status = 'sent')            AS sent,
          COUNT(*) FILTER (WHERE wm.status = 'failed')          AS failed,
          COUNT(*) FILTER (WHERE wm.status = 'delivered')       AS delivered,
          COUNT(*) FILTER (WHERE wm.status = 'read')            AS read,
          COUNT(*) FILTER (WHERE wm.direction = 'inbound')      AS inbound,
          COUNT(*) FILTER (WHERE wm.created_at > NOW() - INTERVAL '24h') AS last_24h,
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE wm.status = 'read') /
            NULLIF(COUNT(*) FILTER (WHERE wm.direction='outbound'),0), 1
          ) AS read_rate
        FROM whatsapp_messages wm
        WHERE TRUE ${msgVisFilter}
      `),

      // Líneas activas — no filtramos por visibilidad (son infraestructura, no contactos)
      query(`
        SELECT line_key, display_name, status, is_connected,
               msgs_sent_today, msg_per_day, evolution_instance
        FROM whatsapp_lines
        WHERE status = 'active'
        ORDER BY priority ASC
        LIMIT 10
      `),

      // Mensajes recientes filtrados por visibilidad
      query(`
        SELECT wm.phone_number, wm.message_body, wm.direction, wm.status, wm.created_at
        FROM whatsapp_messages wm
        WHERE TRUE ${msgVisFilter}
        ORDER BY wm.created_at DESC
        LIMIT 8
      `),

      // Campañas — admins ven todas; operadores ven solo las propias
      user.role === 'admin'
        ? query(`
            SELECT COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE status = 'completed')::int AS sent,
                   COUNT(*) FILTER (WHERE status = 'running')::int   AS sending,
                   COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled
            FROM campaigns
          `)
        : query(`
            SELECT COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE status = 'completed')::int AS sent,
                   COUNT(*) FILTER (WHERE status = 'running')::int   AS sending,
                   COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled
            FROM campaigns
            WHERE owned_by = $1
          `, [user.user_id]),

      // Resumen de contactos visibles para el operador actual
      query(`
        SELECT COUNT(*)::int AS total_contacts
        FROM contacts
        WHERE TRUE ${vis.sql}
      `, vis.params),
    ])

    return NextResponse.json({
      stats:         stats[0],
      lines,
      recent,
      campaignStats: campaignStats[0],
      contactStats:  contactStats[0],
    })
  } catch (e) {
    console.error('[/api/dashboard GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
