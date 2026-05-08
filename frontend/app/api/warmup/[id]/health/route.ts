/**
 * GET /api/warmup/[id]/health
 *
 * Calcula en tiempo real el score de salud de una línea de calentamiento
 * y la cuota diaria recomendada, usando los servicios de la Fase 1.
 *
 * Response:
 *   { line_id, health: HealthResult, schedule: ScheduleResult }
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { getDailyLimitForDay } from '@/lib/warmup-engine'
import { healthCalculatorService } from '@/lib/services/warming/health-calculator.service'
import { dailyQuotaCalculatorService } from '@/lib/services/warming/daily-quota-calculator.service'
import type { DailyStats } from '@/lib/services/warming/health-calculator.service'
import type { DelayPreset } from '@/lib/warmup-engine'

interface WarmupRow {
  id:                  string
  warmup_status:       'active' | 'paused' | 'completed' | 'banned'
  current_day:         number
  target_days:         number
  messages_sent_today: number
  last_message_at:     string | null
  delay_preset:        DelayPreset
}

interface DailyStatsRow {
  date:   string
  sent:   string
  failed: string
}

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const permErr = await checkPermission(req, 'warmup', 'read')
  if (permErr) return permErr

  const { id } = await context.params

  try {
    const rows = await query<WarmupRow>(`
      SELECT id, warmup_status, current_day, target_days,
             messages_sent_today, last_message_at,
             COALESCE(delay_preset, 'normal') AS delay_preset
      FROM   warmup_numbers
      WHERE  id = $1
    `, [id])

    if (!rows.length) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const line = rows[0]

    const statsRows = await query<DailyStatsRow>(`
      SELECT DATE(sent_at)::text                                    AS date,
             COUNT(*) FILTER (WHERE status = 'sent')::text         AS sent,
             COUNT(*) FILTER (WHERE status = 'failed')::text       AS failed
      FROM   warmup_activity_log
      WHERE  warmup_number_id = $1
        AND  sent_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(sent_at)
      ORDER BY DATE(sent_at)
    `, [id])

    const recent7days: DailyStats[] = statsRows.map(r => ({
      date:   r.date,
      sent:   parseInt(r.sent,   10),
      failed: parseInt(r.failed, 10),
    }))

    const effectiveDailyLimit  = getDailyLimitForDay(line.current_day, line.target_days)
    const daysSinceLastMessage = line.last_message_at
      ? (Date.now() - new Date(line.last_message_at).getTime()) / 86_400_000
      : 0

    const health = healthCalculatorService.calculate({
      warmup_status:        line.warmup_status,
      current_day:          line.current_day,
      target_days:          line.target_days,
      effectiveDailyLimit,
      messages_sent_today:  line.messages_sent_today,
      daysSinceLastMessage,
      recent7days,
    })

    const schedule = dailyQuotaCalculatorService.getDailyQuota({
      current_day:         line.current_day,
      target_days:         line.target_days,
      health_score:        health.score,
      delay_preset:        line.delay_preset,
      warmup_status:       line.warmup_status,
      messages_sent_today: line.messages_sent_today,
    })

    return NextResponse.json({ line_id: id, health, schedule })

  } catch (e) {
    console.error('[GET /api/warmup/[id]/health]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
