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
    // Usa campaign_recipients como base de verdad — funciona para campañas
    // con contact_list (contact_id) y con prospect_list (prospect_id).
    const rows = await query(`
      SELECT
        COALESCE(c.id, p.id)               AS id,
        COALESCE(c.first_name, p.first_name) AS first_name,
        COALESCE(c.last_name,  p.last_name)  AS last_name,
        cr.phone_number,
        COALESCE(
          CASE WHEN m.status IN ('delivered', 'read') THEN m.status END,
          CASE WHEN cr.status IN ('failed', 'skipped') THEN cr.status END,
          m.status,
          cr.status
        )                                              AS msg_status,
        m.sent_at,
        m.delivered_at,
        m.read_at,
        COALESCE(m.failed_at, cr.failed_at)            AS failed_at,
        COALESCE(cr.error_detail, m.error_detail)      AS error_detail
      FROM campaign_recipients cr
      LEFT JOIN contacts  c ON c.id = cr.contact_id
      LEFT JOIN prospects p ON p.id = cr.prospect_id
      LEFT JOIN LATERAL (
        SELECT status, sent_at, delivered_at, read_at, failed_at, error_detail
        FROM whatsapp_messages
        WHERE campaign_id = cr.campaign_id
          AND (
            contact_id = cr.contact_id
            OR REPLACE(phone_number, '+', '') = REPLACE(cr.phone_number, '+', '')
          )
        ORDER BY created_at DESC
        LIMIT 1
      ) m ON true
      WHERE cr.campaign_id = $1
      ORDER BY
        CASE COALESCE(m.status, cr.status)
          WHEN 'read'      THEN 1
          WHEN 'delivered' THEN 2
          WHEN 'sent'      THEN 3
          WHEN 'failed'    THEN 4
          WHEN 'skipped'   THEN 5
          WHEN 'sending'   THEN 6
          WHEN 'pending'   THEN 7
          ELSE 8
        END,
        COALESCE(c.first_name, p.first_name)
    `, [id])

    return NextResponse.json({ contacts: rows })
  } catch (e) {
    console.error('[/api/campaigns/contacts GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
