/**
 * GET /api/warmup/history
 *
 * Devuelve el historial de scores de salud de una línea de calentamiento.
 *
 * Query params:
 *   lineId  (required) — UUID de la línea
 *   days    (optional, default 14) — ventana de días hacia atrás
 *
 * Response:
 *   { lineId, history: HealthHistoryPoint[], summary: HistorySummary }
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { warmingOrchestratorService } from '@/lib/services/warming/warming-orchestrator.service'
import type { HealthHistoryPoint } from '@/lib/services/warming/warming-orchestrator.service'
import type { HealthComponents } from '@/lib/services/warming/health-calculator.service'

interface HistoryRow {
  recorded_at:   string
  score:         number
  components:    HealthComponents
  daily_quota:   number
  messages_sent: number
}

export async function GET(req: NextRequest) {
  const permErr = await checkPermission(req, 'warmup', 'read')
  if (permErr) return permErr

  const { searchParams } = new URL(req.url)
  const lineId = searchParams.get('lineId')
  const days   = Math.min(Math.max(parseInt(searchParams.get('days') ?? '14', 10), 1), 90)

  if (!lineId) {
    return NextResponse.json({ error: 'lineId is required' }, { status: 400 })
  }

  try {
    const rows = await query<HistoryRow>(`
      SELECT recorded_at,
             score,
             components,
             daily_quota,
             messages_sent
      FROM   warmup_health_history
      WHERE  warmup_number_id = $1
        AND  recorded_at >= NOW() - ($2 || ' days')::interval
      ORDER  BY recorded_at DESC
    `, [lineId, days])

    const history: HealthHistoryPoint[] = rows.map(r => ({
      recordedAt:   r.recorded_at,
      score:        r.score,
      components:   r.components,
      dailyQuota:   r.daily_quota,
      messagesSent: r.messages_sent,
    }))

    const summary = warmingOrchestratorService.summarizeHistory(history)

    return NextResponse.json({ lineId, history, summary })

  } catch (e) {
    console.error('[GET /api/warmup/history]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
