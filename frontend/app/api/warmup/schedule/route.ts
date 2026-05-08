/**
 * POST /api/warmup/schedule
 *
 * Recalcula el score de salud de todas las líneas de calentamiento y
 * persiste el resultado en warmup_numbers.health_score + health_updated_at.
 *
 * Diseñado para ser invocado:
 *   - Una vez por día (ej: cron n8n a las 00:05)
 *   - Después de eventos que impacten la salud (ban detectado, reset, etc.)
 *   - Manualmente desde el dashboard para forzar recálculo
 *
 * Seguridad: mismo mecanismo que /api/warmup/process (X-Warmup-Secret).
 *
 * GET /api/warmup/schedule
 * Devuelve el estado actual (health_score almacenado) de todas las líneas
 * sin recalcular. Útil para dashboards de monitoreo.
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { getDailyLimitForDay } from '@/lib/warmup-engine'
import { healthCalculatorService } from '@/lib/services/warming/health-calculator.service'
import { dailyQuotaCalculatorService } from '@/lib/services/warming/daily-quota-calculator.service'
import type { DailyStats }          from '@/lib/services/warming/health-calculator.service'
import type { DelayPreset }         from '@/lib/warmup-engine'

// ── Tipos internos ─────────────────────────────────────────────────────────────

interface WarmupLineRow {
  id:                  string
  warmup_status:       'active' | 'paused' | 'completed' | 'banned'
  current_day:         number
  target_days:         number
  messages_sent_today: number
  last_message_at:     string | null
  delay_preset:        DelayPreset
}

interface DailyStatsRow {
  warmup_number_id: string
  date:             string
  sent:             string
  failed:           string
}

// ── GET — estado almacenado ────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const permErr = await checkPermission(req, 'warmup', 'read')
  if (permErr) return permErr

  try {
    const rows = await query(`
      SELECT id, phone_number, instance_name, display_name,
             warmup_status, current_day, target_days,
             COALESCE(health_score, 50)       AS health_score,
             health_updated_at
      FROM   warmup_numbers
      ORDER  BY health_score ASC, warmup_status
    `)
    return NextResponse.json({ lines: rows })
  } catch (e) {
    console.error('[GET /api/warmup/schedule]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── POST — recalcular y persistir ─────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Seguridad ligera (mismo patrón que /process)
  const secret = process.env.WARMUP_PROCESS_SECRET
  if (secret && req.headers.get('x-warmup-secret') !== secret) {
    // Intentar RBAC como alternativa (llamadas desde el dashboard)
    const permErr = await checkPermission(req, 'warmup', 'update')
    if (permErr) return permErr
  }

  const startedAt = Date.now()

  try {
    // 1. Obtener todas las líneas (no solo activas; pausadas y completadas también se recalculan)
    const lines = await query<WarmupLineRow>(`
      SELECT id, warmup_status, current_day, target_days,
             messages_sent_today, last_message_at,
             COALESCE(delay_preset, 'normal') AS delay_preset
      FROM   warmup_numbers
      ORDER  BY id
    `)

    if (!lines.length) {
      return NextResponse.json({ ok: true, updated: 0, elapsed_ms: Date.now() - startedAt })
    }

    // 2. Obtener stats de los últimos 7 días para todas las líneas en una sola query
    const ids     = lines.map(l => l.id)
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

    // Indexar stats por line_id para O(1) lookup
    const statsByLine = new Map<string, DailyStats[]>()
    for (const r of statsRows) {
      const entry: DailyStats = {
        date:   r.date,
        sent:   parseInt(r.sent,   10),
        failed: parseInt(r.failed, 10),
      }
      const existing = statsByLine.get(r.warmup_number_id) ?? []
      existing.push(entry)
      statsByLine.set(r.warmup_number_id, existing)
    }

    // 3. Calcular y acumular actualizaciones
    const updates: Array<{ id: string; score: number; shouldSendToday: boolean }> = []

    for (const line of lines) {
      const recent7days = statsByLine.get(line.id) ?? []

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

      updates.push({ id: line.id, score: health.score, shouldSendToday: schedule.shouldSendToday })
    }

    // 4. Persistir en lote usando unnest (una sola query)
    const ids_arr    = updates.map(u => u.id)
    const scores_arr = updates.map(u => u.score)

    await query(`
      UPDATE warmup_numbers AS w
      SET    health_score      = v.score::integer,
             health_updated_at = NOW()
      FROM   unnest($1::uuid[], $2::integer[]) AS v(id, score)
      WHERE  w.id = v.id
    `, [ids_arr, scores_arr])

    const elapsed = Date.now() - startedAt
    console.info(`[POST /api/warmup/schedule] ${updates.length} líneas actualizadas en ${elapsed}ms`)

    return NextResponse.json({
      ok:         true,
      updated:    updates.length,
      elapsed_ms: elapsed,
      summary: updates.map(u => ({
        id:              u.id,
        health_score:    u.score,
        should_send:     u.shouldSendToday,
      })),
    })

  } catch (e) {
    console.error('[POST /api/warmup/schedule]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
