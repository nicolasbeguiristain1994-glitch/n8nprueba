import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { lineEligibleExpr } from '@/lib/line-eligibility'

type LineHealthRow = {
  id:                 string
  line_key:           string
  display_name:       string
  status:             string
  is_connected:       boolean
  sending_enabled:    boolean
  phone_number:       string | null
  evolution_instance: string
  msg_per_hour:       number
  msg_per_day:        number
  msgs_sent_hour:     number
  msgs_sent_today:    number
  remaining_hour:     number
  remaining_day:      number
  hour_capacity_pct:  number
  day_capacity_pct:   number
  priority:           number
  last_seen_at:       string | null
  last_error:         string | null
  last_error_at:      string | null
  // Aggregated from line_usage_log
  recent_sent:        number
  recent_failed:      number
  eligible:           boolean
}

// ── GET /api/lines/health ─────────────────────────────────────────────────────
// Returns the health/readiness overview of all WhatsApp lines relevant to
// campaign distribution. Includes:
//   - Current counters (hourly + daily sent, remaining capacity)
//   - Connection and send-enabled status
//   - Whether the line is currently eligible for campaign sends
//   - Recent send/fail counts from line_usage_log (last 24h)
//
// Access: lines:read

export async function GET(req: Request) {
  const err = await checkPermission(req, 'lines', 'read')
  if (err) return err

  try {
    const lines = await query<LineHealthRow>(`
      SELECT
        l.id,
        l.line_key,
        l.display_name,
        l.status,
        l.is_connected,
        l.sending_enabled,
        l.phone_number,
        l.evolution_instance,
        l.msg_per_hour,
        l.msg_per_day,
        l.msgs_sent_hour,
        l.msgs_sent_today,
        (l.msg_per_hour  - l.msgs_sent_hour)  AS remaining_hour,
        (l.msg_per_day   - l.msgs_sent_today) AS remaining_day,
        ROUND(100.0 * l.msgs_sent_hour  / NULLIF(l.msg_per_hour, 0), 1) AS hour_capacity_pct,
        ROUND(100.0 * l.msgs_sent_today / NULLIF(l.msg_per_day,  0), 1) AS day_capacity_pct,
        l.priority,
        l.last_seen_at,
        NULL::text AS last_error,
        NULL::timestamptz AS last_error_at,
        -- Recent activity from line_usage_log (last 24h)
        COALESCE(lu.sent_24h,   0) AS recent_sent,
        COALESCE(lu.failed_24h, 0) AS recent_failed,
        -- Eligible = all conditions met for campaign dispatch
        ${lineEligibleExpr('l')} AS eligible
      FROM whatsapp_lines l
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE status = 'sent')::int   AS sent_24h,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_24h
        FROM line_usage_log
        WHERE line_id    = l.id
          AND created_at > NOW() - INTERVAL '24 hours'
      ) lu ON true
      ORDER BY l.priority ASC, l.line_key ASC
    `)

    const eligible_count = lines.filter(l => l.eligible).length

    return NextResponse.json({
      lines,
      summary: {
        total:            lines.length,
        eligible:         eligible_count,
        connected:        lines.filter(l => l.is_connected).length,
        sending_enabled:  lines.filter(l => l.sending_enabled).length,
        active:           lines.filter(l => l.status === 'active').length,
      },
    })
  } catch (e) {
    console.error('[GET /api/lines/health]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
