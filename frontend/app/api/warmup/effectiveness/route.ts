/**
 * GET /api/warmup/effectiveness
 *
 * Calcula el reporte de efectividad del módulo de calentamiento
 * sobre el estado actual de todas las líneas.
 *
 * También devuelve los últimos snapshots históricos almacenados.
 *
 * Response:
 *   { report: EffectivenessReport, snapshots: SnapshotRow[] }
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { warmingEffectivenessService } from '@/lib/services/warming/warming-effectiveness.service'
import type { EffectivenessLineInput } from '@/lib/services/warming/warming-effectiveness.service'
import type { DelayPreset } from '@/lib/warmup-engine'

interface LineRow {
  id:            string
  warmup_status: 'active' | 'paused' | 'completed' | 'banned'
  current_day:   number
  target_days:   number
  delay_preset:  DelayPreset
  health_score:  number
}

interface SnapshotRow {
  id:               string
  period:           string
  period_start:     string
  period_end:       string
  total_lines:      number
  completed_lines:  number
  banned_lines:     number
  success_rate:     string
  completion_ratio: string
  by_strategy:      unknown
  recorded_at:      string
}

export async function GET(req: NextRequest) {
  const permErr = await checkPermission(req, 'warmup', 'read')
  if (permErr) return permErr

  try {
    const lineRows = await query<LineRow>(`
      SELECT id, warmup_status, current_day, target_days,
             COALESCE(delay_preset, 'normal') AS delay_preset,
             COALESCE(health_score, 50)       AS health_score
      FROM   warmup_numbers
      ORDER  BY id
    `)

    const inputs: EffectivenessLineInput[] = lineRows.map(r => ({
      id:            r.id,
      warmup_status: r.warmup_status,
      current_day:   r.current_day,
      target_days:   r.target_days,
      delay_preset:  r.delay_preset,
      health_score:  r.health_score,
    }))

    const report = warmingEffectivenessService.computeReport(inputs)

    // Últimos 8 snapshots (4 semanas o 2 meses) para visualizar tendencia
    const snapshots = await query<SnapshotRow>(`
      SELECT id, period, period_start, period_end,
             total_lines, completed_lines, banned_lines,
             success_rate, completion_ratio, by_strategy, recorded_at
      FROM   warmup_effectiveness_snapshots
      ORDER  BY recorded_at DESC
      LIMIT  8
    `)

    return NextResponse.json({ report, snapshots })

  } catch (e) {
    console.error('[GET /api/warmup/effectiveness]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
