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

  // ── Intento 1: campaign_recipients (campañas modernas con distributor) ──────
  try {
    const rows = await query(`
      SELECT
        COALESCE(c.id, p.id)                     AS id,
        c.id                                      AS contact_id,
        p.id                                      AS prospect_id,
        COALESCE(c.first_name, p.first_name)     AS first_name,
        COALESCE(c.last_name,  p.last_name)      AS last_name,
        cr.phone_number,
        COALESCE(
          CASE WHEN m.status IN ('delivered', 'read') THEN m.status END,
          CASE WHEN cr.status IN ('failed', 'skipped') THEN cr.status END,
          m.status,
          cr.status
        )                                         AS msg_status,
        m.sent_at,
        m.delivered_at,
        m.read_at,
        COALESCE(m.failed_at, cr.failed_at)       AS failed_at,
        COALESCE(cr.error_detail, m.error_detail) AS error_detail
      FROM campaign_recipients cr
      LEFT JOIN contacts  c ON c.id = cr.contact_id
      LEFT JOIN prospects p ON p.id = cr.prospect_id
      LEFT JOIN LATERAL (
        SELECT status, sent_at, delivered_at, read_at, failed_at, error_detail
        FROM   whatsapp_messages wm
        WHERE  wm.campaign_id = cr.campaign_id
          AND  REPLACE(wm.phone_number, '+', '') = REPLACE(cr.phone_number, '+', '')
        ORDER BY wm.created_at DESC
        LIMIT 1
      ) m ON true
      WHERE cr.campaign_id = $1
      ORDER BY
        CASE COALESCE(m.status, cr.status)
          WHEN 'read'      THEN 1  WHEN 'delivered' THEN 2  WHEN 'sent'      THEN 3
          WHEN 'failed'    THEN 4  WHEN 'skipped'   THEN 5  WHEN 'sending'   THEN 6
          WHEN 'pending'   THEN 7  ELSE 8
        END, COALESCE(c.first_name, p.first_name)
    `, [id])
    if (rows.length > 0) return NextResponse.json({ contacts: rows })
  } catch (e) {
    console.warn('[contacts] attempt 1 failed:', (e as Error).message)
  }

  // ── Intento 2: miembros de lista (contact_list o prospect_list) ──────────
  try {
    const rows = await query(`
      SELECT
        COALESCE(c.id, p.id)                      AS id,
        c.id                                       AS contact_id,
        p.id                                       AS prospect_id,
        COALESCE(c.first_name, p.first_name)      AS first_name,
        COALESCE(c.last_name,  p.last_name)       AS last_name,
        COALESCE(c.phone_number, p.phone_number)  AS phone_number,
        COALESCE(
          CASE WHEN m.status IN ('delivered', 'read') THEN m.status END,
          m.status
        )                                          AS msg_status,
        m.sent_at, m.delivered_at, m.read_at, m.failed_at, m.error_detail
      FROM campaigns camp
      LEFT JOIN contact_list_members  clm ON clm.list_id          = camp.list_id
      LEFT JOIN contacts              c   ON c.id                 = clm.contact_id
      LEFT JOIN prospect_list_members plm ON plm.prospect_list_id = camp.prospect_list_id
      LEFT JOIN prospects             p   ON p.id                 = plm.prospect_id
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
        CASE m.status
          WHEN 'read' THEN 1  WHEN 'delivered' THEN 2  WHEN 'sent'    THEN 3
          WHEN 'failed' THEN 4  WHEN 'skipped' THEN 5  WHEN 'sending' THEN 6
          WHEN 'pending' THEN 7  ELSE 8
        END, COALESCE(c.first_name, p.first_name)
    `, [id])
    if (rows.length > 0) return NextResponse.json({ contacts: rows })
  } catch (e) {
    console.warn('[contacts] attempt 2 failed:', (e as Error).message)
  }

  // ── Intento 3: whatsapp_messages + match por últimos 10 dígitos ─────────────
  // Cubre casos donde el número está guardado con/sin prefijo de país (e.g. +549... vs +1...).
  try {
    const rows = await query(`
      SELECT DISTINCT ON (RIGHT(REGEXP_REPLACE(wm.phone_number, '[^0-9]', '', 'g'), 10))
        COALESCE(c.id::text, p.id::text, wm.id::text)    AS id,
        c.id                                              AS contact_id,
        p.id                                              AS prospect_id,
        COALESCE(c.first_name, p.first_name)              AS first_name,
        COALESCE(c.last_name,  p.last_name)               AS last_name,
        wm.phone_number,
        wm.status   AS msg_status,
        wm.sent_at, wm.delivered_at, wm.read_at, wm.failed_at, wm.error_detail
      FROM whatsapp_messages wm
      LEFT JOIN contacts  c
        ON RIGHT(REGEXP_REPLACE(c.phone_number, '[^0-9]', '', 'g'), 10)
         = RIGHT(REGEXP_REPLACE(wm.phone_number, '[^0-9]', '', 'g'), 10)
      LEFT JOIN prospects p
        ON RIGHT(REGEXP_REPLACE(p.phone_number, '[^0-9]', '', 'g'), 10)
         = RIGHT(REGEXP_REPLACE(wm.phone_number, '[^0-9]', '', 'g'), 10)
      WHERE wm.campaign_id = $1
      ORDER BY
        RIGHT(REGEXP_REPLACE(wm.phone_number, '[^0-9]', '', 'g'), 10),
        CASE wm.status
          WHEN 'read' THEN 1  WHEN 'delivered' THEN 2  WHEN 'sent'    THEN 3
          WHEN 'failed' THEN 4  WHEN 'skipped' THEN 5  ELSE 6
        END,
        wm.created_at DESC
    `, [id])
    return NextResponse.json({ contacts: rows })
  } catch (e) {
    // Fallback sin prospects (tabla puede no existir aún)
    try {
      const rows = await query(`
        SELECT DISTINCT ON (RIGHT(REGEXP_REPLACE(wm.phone_number, '[^0-9]', '', 'g'), 10))
          COALESCE(c.id::text, wm.id::text) AS id,
          c.id AS contact_id,
          NULL::uuid AS prospect_id,
          c.first_name, c.last_name,
          wm.phone_number,
          wm.status AS msg_status,
          wm.sent_at, wm.delivered_at, wm.read_at, wm.failed_at, wm.error_detail
        FROM whatsapp_messages wm
        LEFT JOIN contacts c
          ON RIGHT(REGEXP_REPLACE(c.phone_number, '[^0-9]', '', 'g'), 10)
           = RIGHT(REGEXP_REPLACE(wm.phone_number, '[^0-9]', '', 'g'), 10)
        WHERE wm.campaign_id = $1
        ORDER BY RIGHT(REGEXP_REPLACE(wm.phone_number, '[^0-9]', '', 'g'), 10), wm.created_at DESC
      `, [id])
      return NextResponse.json({ contacts: rows })
    } catch (e2) {
      console.error('[contacts] attempt 3 failed:', (e2 as Error).message)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}
