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

  if (session.role !== 'admin') {
    const [row] = await query<{ owned_by: string | null }>(
      'SELECT owned_by FROM campaigns WHERE id = $1', [id]
    )
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!isCampaignOwnerOrAdmin(session, row.owned_by))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    // Estrategia: partir desde los miembros de la lista (contact_list o prospect_list)
    // y hacer LEFT JOIN con campaign_recipients y whatsapp_messages.
    // Esto cubre:
    //   - Campañas con contact_list (list_id)
    //   - Campañas con prospect_list (prospect_list_id)
    //   - Campañas antiguas donde campaign_recipients está vacío pero hay whatsapp_messages
    const rows = await query(`
      SELECT
        COALESCE(c.id, p.id)                    AS id,
        COALESCE(c.first_name, p.first_name)    AS first_name,
        COALESCE(c.last_name,  p.last_name)     AS last_name,
        COALESCE(c.phone_number, p.phone_number) AS phone_number,
        COALESCE(
          CASE WHEN m.status IN ('delivered', 'read') THEN m.status END,
          CASE WHEN cr.status IN ('failed', 'skipped') THEN cr.status END,
          m.status,
          cr.status
        )                                        AS msg_status,
        m.sent_at,
        m.delivered_at,
        m.read_at,
        COALESCE(m.failed_at, cr.failed_at)      AS failed_at,
        COALESCE(cr.error_detail, m.error_detail) AS error_detail
      FROM campaigns camp

      -- Ruta contact_list
      LEFT JOIN contact_list_members  clm ON clm.list_id          = camp.list_id
      LEFT JOIN contacts              c   ON c.id                 = clm.contact_id

      -- Ruta prospect_list
      LEFT JOIN prospect_list_members plm ON plm.prospect_list_id = camp.prospect_list_id
      LEFT JOIN prospects             p   ON p.id                 = plm.prospect_id

      -- Estado de envío en campaign_recipients (campañas modernas)
      LEFT JOIN campaign_recipients   cr
        ON  cr.campaign_id = camp.id
        AND (
              (cr.contact_id  = c.id AND c.id IS NOT NULL)
          OR  (cr.prospect_id = p.id AND p.id IS NOT NULL)
        )

      -- Último mensaje de WhatsApp por número (cubre campañas sin campaign_recipients)
      LEFT JOIN LATERAL (
        SELECT status, sent_at, delivered_at, read_at, failed_at, error_detail
        FROM   whatsapp_messages wm
        WHERE  wm.campaign_id = camp.id
          AND  REPLACE(wm.phone_number, '+', '') =
               REPLACE(COALESCE(c.phone_number, p.phone_number), '+', '')
        ORDER BY wm.created_at DESC
        LIMIT 1
      ) m ON true

      WHERE camp.id = $1
        AND (c.id IS NOT NULL OR p.id IS NOT NULL)

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
