import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = await checkPermission(req, 'warmup', 'read')
  if (err) return err

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const url       = new URL(req.url)
  const logsOffset = Math.max(0, parseInt(url.searchParams.get('logs_offset') ?? '0', 10))
  const logsLimit  = Math.min(200, Math.max(1, parseInt(url.searchParams.get('logs_limit') ?? '50', 10)))

  try {
    const rows = await query<{
      id: string; phone_number: string; instance_name: string; display_name: string | null
      warmup_status: string; current_day: number; target_days: number
      messages_sent_today: number; daily_limit: number
      last_message_at: string | null; start_date: string | null
      notes: string | null; timezone: string; delay_preset: string
      anti_ban_enabled: boolean | null; delay_min_seconds: number | null
      delay_max_seconds: number | null; sending_window_start: string | null
      sending_window_end: string | null; active_days: number[] | null
      randomness_level: string | null; natural_distribution: boolean | null
    }>(`
      SELECT id, phone_number, instance_name, display_name, warmup_status,
             current_day, target_days, messages_sent_today, daily_limit,
             last_message_at, start_date, notes, timezone,
             COALESCE(delay_preset, 'normal') AS delay_preset,
             anti_ban_enabled, delay_min_seconds, delay_max_seconds,
             sending_window_start::text, sending_window_end::text,
             active_days, randomness_level, natural_distribution
      FROM warmup_numbers
      WHERE id = $1
    `, [id])

    if (!rows.length) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })

    const dailyStats = await query<{
      day: number; sent: number; failed: number; skipped: number
    }>(`
      SELECT warmup_day AS day,
             COUNT(*) FILTER (WHERE status = 'sent')::int    AS sent,
             COUNT(*) FILTER (WHERE status = 'failed')::int  AS failed,
             COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped
      FROM warmup_activity_log
      WHERE warmup_number_id = $1
      GROUP BY warmup_day
      ORDER BY warmup_day ASC
    `, [id])

    const recentLogs = await query<{
      id: string; recipient: string; message_type: string
      message_preview: string; status: string; warmup_day: number; sent_at: string
    }>(`
      SELECT id, recipient, message_type, message_preview, status, warmup_day, sent_at
      FROM warmup_activity_log
      WHERE warmup_number_id = $1
      ORDER BY sent_at DESC
      LIMIT $2 OFFSET $3
    `, [id, logsLimit, logsOffset])

    const totalLogsRes = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM warmup_activity_log WHERE warmup_number_id = $1`, [id]
    )
    const totalLogs = parseInt(totalLogsRes[0]?.count ?? '0', 10)

    const totalSent     = dailyStats.reduce((s, d) => s + d.sent, 0)
    const totalFailed   = dailyStats.reduce((s, d) => s + d.failed, 0)
    const totalAttempts = totalSent + totalFailed
    const successRate   = totalAttempts > 0 ? Math.round((totalSent / totalAttempts) * 100) : null

    return NextResponse.json({
      line:         rows[0],
      daily_stats:  dailyStats,
      recent_logs:  recentLogs,
      success_rate: successRate,
      total_sent:   totalSent,
      total_logs:   totalLogs,
    })
  } catch (e) {
    console.error('[/api/warmup/[id]/detail GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
