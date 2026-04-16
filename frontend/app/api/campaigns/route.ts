import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function GET() {
  const campaigns = await query(`
    SELECT c.id, c.name, c.message, c.messages, c.status, c.scheduled_at,
           c.started_at, c.completed_at,
           c.total_targets, c.personalize_name,
           c.antiblock_delay_min, c.antiblock_delay_max,
           c.created_at, cl.name AS list_name,
           -- Contar directamente desde whatsapp_messages para precisión en tiempo real
           COUNT(m.id) FILTER (WHERE m.status IN ('sent','delivered','read'))::int AS total_sent,
           COUNT(m.id) FILTER (WHERE m.status = 'delivered')::int               AS total_delivered,
           COUNT(m.id) FILTER (WHERE m.status = 'read')::int                    AS total_read,
           COUNT(m.id) FILTER (WHERE m.status = 'failed')::int                  AS total_failed,
           CASE WHEN COUNT(m.id) FILTER (WHERE m.status IN ('sent','delivered','read')) > 0
             THEN ROUND(COUNT(m.id) FILTER (WHERE m.status = 'read')::numeric /
                        COUNT(m.id) FILTER (WHERE m.status IN ('sent','delivered','read')) * 100, 1)
             ELSE 0 END AS read_rate,
           CASE WHEN c.total_targets > 0
             THEN ROUND(COUNT(m.id) FILTER (WHERE m.status IN ('sent','delivered','read'))::numeric /
                        c.total_targets * 100, 1)
             ELSE 0 END AS delivery_rate
    FROM campaigns c
    LEFT JOIN contact_lists cl ON cl.id = c.list_id
    LEFT JOIN whatsapp_messages m ON m.campaign_id = c.id
    GROUP BY c.id, cl.name
    ORDER BY c.created_at DESC
  `)
  return NextResponse.json({ campaigns })
}

export async function POST(req: NextRequest) {
  const { name, message, messages, media_url, media_type, list_id, scheduled_at,
          antiblock_delay_min, antiblock_delay_max, type: campaignType,
          personalize_name } = await req.json()

  // messages[] takes priority; fall back to single message
  const msgArray: string[] = Array.isArray(messages) && messages.length > 0
    ? messages.filter((m: string) => m?.trim())
    : (message ? [message] : [])

  if (!name || msgArray.length === 0)
    return NextResponse.json({ error: 'name y al menos un mensaje son requeridos' }, { status: 400 })

  let total_targets = 0
  if (list_id) {
    const [r] = await query<{ count: string }>(
      'SELECT COUNT(*)::int AS count FROM contact_list_members WHERE list_id = $1', [list_id]
    )
    total_targets = Number(r?.count || 0)
  }

  const [campaign] = await query<{ id: string }>(
    `INSERT INTO campaigns
       (name, message, messages, media_url, media_type, list_id, type, status, scheduled_at,
        total_targets, antiblock_delay_min, antiblock_delay_max, personalize_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [name, msgArray[0], JSON.stringify(msgArray), media_url || null, media_type || null,
     list_id || null, campaignType || 'promotion',
     scheduled_at ? 'scheduled' : 'draft',
     scheduled_at || null, total_targets,
     antiblock_delay_min ?? 3, antiblock_delay_max ?? 8,
     personalize_name !== false]
  )

  return NextResponse.json({ id: campaign.id, name, status: scheduled_at ? 'scheduled' : 'draft' })
}
