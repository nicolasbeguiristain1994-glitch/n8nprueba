import { NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function GET() {
  try {
    const [stats, lines, recent, campaignStats] = await Promise.all([
      query(`
        SELECT
          COUNT(*)                                                AS total,
          COUNT(*) FILTER (WHERE status = 'sent')                AS sent,
          COUNT(*) FILTER (WHERE status = 'failed')              AS failed,
          COUNT(*) FILTER (WHERE status = 'delivered')           AS delivered,
          COUNT(*) FILTER (WHERE status = 'read')                AS read,
          COUNT(*) FILTER (WHERE direction = 'inbound')          AS inbound,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24h') AS last_24h,
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE status = 'read') /
            NULLIF(COUNT(*) FILTER (WHERE direction='outbound'),0), 1
          ) AS read_rate
        FROM whatsapp_messages
      `),
      query(`
        SELECT line_key, display_name, status, is_connected,
               msgs_sent_today, msg_per_day, evolution_instance
        FROM whatsapp_lines
        WHERE status = 'active'
        ORDER BY priority ASC
        LIMIT 10
      `),
      query(`
        SELECT phone_number, message_body, direction, status, created_at
        FROM whatsapp_messages
        ORDER BY created_at DESC
        LIMIT 8
      `),
      query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE status = 'completed')::int AS sent,
               COUNT(*) FILTER (WHERE status = 'running')::int   AS sending,
               COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled
        FROM campaigns
      `),
    ])

    return NextResponse.json({ stats: stats[0], lines, recent, campaignStats: campaignStats[0] })
  } catch (e) {
    console.error('[/api/dashboard GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
