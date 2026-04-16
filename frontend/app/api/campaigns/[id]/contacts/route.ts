import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // Trae todos los contactos de la lista de la campaña
  // y hace LEFT JOIN con los mensajes enviados en esa campaña
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
    LEFT JOIN whatsapp_messages m
      ON m.contact_id = c.id
     AND m.campaign_id = camp.id
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
}
