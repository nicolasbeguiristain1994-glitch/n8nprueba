import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { visibilityClause } from '@/lib/contact-visibility'
import { dashboardMessageStats } from '@/lib/dashboard-messages'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth

  const vis = visibilityClause(user.role, user.user_id, 0)
  const contactParams: unknown[] = [...vis.params]
  let contactFilter = `AND contacts.deleted_at IS NULL ${vis.sql}`
  if (user.role !== 'admin' && !user.sectors?.includes('contacts')) contactFilter += ' AND FALSE'
  if (user.role !== 'admin' && user.allowed_agents?.length) {
    contactParams.push(user.allowed_agents)
    contactFilter += ` AND contacts.panel = ANY($${contactParams.length}::text[])`
  }

  // Filtro de visibilidad para mensajes (operadores ven solo sus contactos)
  const msgVisFilter = user.role === 'admin'
    ? ''
    : `AND wm.phone_number IN (
         SELECT c.phone_number FROM contacts c
         JOIN operator_contact_visibility ocv ON ocv.contact_id = c.id
         WHERE ocv.operator_id = '${user.user_id}'
       )`

  try {
    // Manual refresh must read current outcomes; cached counters hid new replies.
    const compute = async () => {
      const [stats, lines, recent, campaignStats, contactStats] = await Promise.all([
        dashboardMessageStats(user.role === 'admin' ? null : user.user_id),

        // Líneas activas — infraestructura global, no requiere filtro por usuario
        query(`
          SELECT line_key, display_name, status, is_connected,
                 msgs_sent_today, msg_per_day, evolution_instance
          FROM whatsapp_lines
          WHERE status = 'active'
          ORDER BY priority ASC
          LIMIT 10
        `),

        // Mensajes recientes — ventana de 7 días para índice idx_wm_created_status_outbound
        query(`
          SELECT wm.phone_number, wm.message_body, wm.direction, wm.status, wm.created_at
          FROM whatsapp_messages wm
          WHERE wm.created_at > NOW() - INTERVAL '7 days'
            ${msgVisFilter}
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

        // Total de contactos visibles para el operador
        query(`
          SELECT COUNT(*)::int AS total_contacts
          FROM contacts
          WHERE TRUE ${contactFilter}
        `, contactParams),
      ])

      return {
        stats,
        lines,
        recent,
        campaignStats: campaignStats[0],
        contactStats:  contactStats[0],
      }
    }

    return NextResponse.json(await compute(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[/api/dashboard GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
