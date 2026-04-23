import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser, isCampaignOwnerOrAdmin } from '@/lib/permissions'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'read')
  if (!auth.ok) return auth.response

  const session = auth.user
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  // Ownership check for non-admin users
  if (session.role !== 'admin') {
    const [row] = await query<{ owned_by: string | null }>(
      'SELECT owned_by FROM campaigns WHERE id = $1', [id]
    )
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!isCampaignOwnerOrAdmin(session, row.owned_by))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    // Trae todos los contactos de la lista de la campaña
    // y hace LEFT JOIN con los mensajes enviados en esa campaña
    // LATERAL subquery keeps exactly one (latest) message per contact,
    // preventing duplicate rows when a contact has multiple whatsapp_messages
    // rows for the same campaign (e.g. retry after crash).
    const rows = await query(`
      SELECT
        c.id,
        c.first_name,
        c.last_name,
        c.phone_number,
        m.status        AS msg_status,
        m.sent_at,
        m.delivered_at,
        m.read_at,
        m.failed_at,
        m.error_detail
      FROM campaigns camp
      JOIN contact_list_members clm ON clm.list_id = camp.list_id
      JOIN contacts c ON c.id = clm.contact_id
      LEFT JOIN LATERAL (
        SELECT status, sent_at, delivered_at, read_at, failed_at, error_detail
        FROM whatsapp_messages
        WHERE contact_id = c.id
          AND campaign_id = camp.id
        ORDER BY created_at DESC
        LIMIT 1
      ) m ON true
      WHERE camp.id = $1
      ORDER BY
        CASE m.status
          WHEN 'read'      THEN 1
          WHEN 'delivered' THEN 2
          WHEN 'sent'      THEN 3
          WHEN 'failed'    THEN 4
          ELSE 5
        END,
        c.first_name
    `, [id])

    return NextResponse.json({ contacts: rows })
  } catch (e) {
    console.error('[/api/campaigns/contacts GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
