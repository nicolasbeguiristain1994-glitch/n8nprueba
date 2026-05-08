/**
 * GET /api/warmup/orchestrator/plan
 *
 * Devuelve el plan de distribución de cuota del día actual
 * calculado en tiempo real (sin persistir).
 *
 * Útil para dashboards: muestra cómo se distribuyen los mensajes
 * de hoy entre las líneas activas con sus pesos y cuotas.
 *
 * Response:
 *   { plan: OrchestrationResult, generatedAt: string }
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { getDailyLimitForDay } from '@/lib/warmup-engine'
import { warmingOrchestratorService } from '@/lib/services/warming/warming-orchestrator.service'
import type { OrchestratorLineInput } from '@/lib/services/warming/warming-orchestrator.service'
import type { DelayPreset } from '@/lib/warmup-engine'

interface WarmupLineRow {
  id:                  string
  warmup_status:       'active' | 'paused' | 'completed' | 'banned'
  current_day:         number
  target_days:         number
  messages_sent_today: number
  last_message_at:     string | null
  delay_preset:        DelayPreset
  phone_number:        string
  instance_name:       string | null
  display_name:        string | null
}

interface DailyStatsRow {
  warmup_number_id: string
  date:             string
  sent:             string
  failed:           string
}

export async function GET(req: NextRequest) {
  const permErr = await checkPermission(req, 'warmup', 'read')
  if (permErr) return permErr

  try {
    const lines = await query<WarmupLineRow>(`
      SELECT id, warmup_status, current_day, target_days,
             messages_sent_today, last_message_at,
             COALESCE(delay_preset, 'normal') AS delay_preset,
             phone_number, instance_name, display_name
      FROM   warmup_numbers
      ORDER  BY id
    `)

    if (!lines.length) {
      return NextResponse.json({
        plan:        { lines: [], totalActiveLines: 0, totalDailyQuota: 0, totalRemainingToday: 0, orchestratedAt: new Date().toISOString() },
        generatedAt: new Date().toISOString(),
      })
    }

    const ids       = lines.map(l => l.id)
    const statsRows = await query<DailyStatsRow>(`
      SELECT warmup_number_id,
             DATE(sent_at)::text                              AS date,
             COUNT(*) FILTER (WHERE status = 'sent')::text   AS sent,
             COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
      FROM   warmup_activity_log
      WHERE  warmup_number_id = ANY($1::uuid[])
        AND  sent_at >= NOW() - INTERVAL '7 days'
      GROUP  BY warmup_number_id, DATE(sent_at)
    `, [ids])

    const statsByLine = new Map<string, Array<{ date: string; sent: number; failed: number }>>()
    for (const r of statsRows) {
      const entry = { date: r.date, sent: parseInt(r.sent, 10), failed: parseInt(r.failed, 10) }
      const existing = statsByLine.get(r.warmup_number_id) ?? []
      existing.push(entry)
      statsByLine.set(r.warmup_number_id, existing)
    }

    const now = Date.now()
    const inputs: OrchestratorLineInput[] = lines.map(line => ({
      id:                   line.id,
      warmup_status:        line.warmup_status,
      current_day:          line.current_day,
      target_days:          line.target_days,
      effectiveDailyLimit:  getDailyLimitForDay(line.current_day, line.target_days),
      messages_sent_today:  line.messages_sent_today,
      daysSinceLastMessage: line.last_message_at
        ? (now - new Date(line.last_message_at).getTime()) / 86_400_000
        : 0,
      delay_preset:         line.delay_preset,
      recent7days:          statsByLine.get(line.id) ?? [],
    }))

    const result = warmingOrchestratorService.orchestrate(inputs)

    // Enriquecer con metadata de identificación para el dashboard
    const enrichedLines = result.lines.map(r => {
      const meta = lines.find(l => l.id === r.lineId)!
      return {
        ...r,
        phone_number:  meta.phone_number,
        instance_name: meta.instance_name,
        display_name:  meta.display_name,
      }
    })

    return NextResponse.json({
      plan: { ...result, lines: enrichedLines },
      generatedAt: new Date().toISOString(),
    })

  } catch (e) {
    console.error('[GET /api/warmup/orchestrator/plan]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
