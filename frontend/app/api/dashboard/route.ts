import { contactPhoneScope } from '@/lib/contact-visibility'
import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { contactScope } from '@/lib/contact-visibility'
import { dashboardMessageStats } from '@/lib/dashboard-messages'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth

  const vis = contactScope(user)
  const contactParams: unknown[] = [...vis.params]
  let contactFilter = `AND ${vis.sql}`
  if (user.role !== 'admin' && !user.sectors?.includes('contacts')) contactFilter += ' AND FALSE'
  const messageScope = contactPhoneScope(user, 'wm.phone_number', 0, user.role === 'admin')
  const msgVisFilter = `AND ${messageScope.sql}${user.role !== 'admin' && !user.sectors.includes('conversations') ? ' AND FALSE' : ''}`

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
        `, messageScope.params),

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
