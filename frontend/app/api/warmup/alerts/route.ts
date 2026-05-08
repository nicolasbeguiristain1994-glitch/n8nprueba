/**
 * GET /api/warmup/alerts
 *
 * Lista alertas predictivas del sistema de calentamiento.
 *
 * Query params:
 *   lineId   (optional) — filtrar por línea
 *   severity (optional) — filtrar por severidad
 *   resolved (optional, default "false") — "true" incluye resueltas
 *   limit    (optional, default 50, max 200)
 *
 * Response:
 *   { alerts: AlertRow[], total: number }
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

interface AlertRow {
  id:               string
  warmup_number_id: string
  severity:         string
  type:             string
  message:          string
  data:             Record<string, unknown>
  triggered_at:     string
  resolved_at:      string | null
  resolved_by:      string | null
  // joined
  phone_number:     string
  instance_name:    string
  display_name:     string | null
}

export async function GET(req: NextRequest) {
  const permErr = await checkPermission(req, 'warmup', 'read')
  if (permErr) return permErr

  const sp       = new URL(req.url).searchParams
  const lineId   = sp.get('lineId')
  const severity = sp.get('severity')
  const resolved = sp.get('resolved') === 'true'
  const limit    = Math.min(Math.max(parseInt(sp.get('limit') ?? '50', 10), 1), 200)

  try {
    const conditions: string[] = []
    const params: unknown[]    = []
    let p = 1

    if (lineId) {
      conditions.push(`a.warmup_number_id = $${p++}`)
      params.push(lineId)
    }

    if (severity) {
      conditions.push(`a.severity = $${p++}`)
      params.push(severity)
    }

    if (!resolved) {
      conditions.push('a.resolved_at IS NULL')
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = await query<AlertRow>(`
      SELECT a.id, a.warmup_number_id, a.severity, a.type, a.message,
             a.data, a.triggered_at, a.resolved_at, a.resolved_by,
             w.phone_number, w.instance_name, w.display_name
      FROM   warmup_alerts a
      JOIN   warmup_numbers w ON w.id = a.warmup_number_id
      ${where}
      ORDER  BY
        CASE a.severity
          WHEN 'critical' THEN 1
          WHEN 'high'     THEN 2
          WHEN 'medium'   THEN 3
          ELSE 4
        END,
        a.triggered_at DESC
      LIMIT  $${p}
    `, [...params, limit])

    const countRow = await query<{ total: string }>(`
      SELECT COUNT(*) AS total
      FROM   warmup_alerts a
      ${where}
    `, params)

    return NextResponse.json({
      alerts: rows,
      total:  parseInt(countRow[0]?.total ?? '0', 10),
    })

  } catch (e) {
    console.error('[GET /api/warmup/alerts]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
