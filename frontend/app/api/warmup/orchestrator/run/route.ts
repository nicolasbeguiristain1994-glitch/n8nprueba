/**
 * POST /api/warmup/orchestrator/run
 *
 * Ejecuta la orquestación diaria de calentamiento:
 *   1. Calcula salud + cuota de cada línea
 *   2. Persiste resultados en warmup_numbers (health_score, health_updated_at)
 *   3. Inserta snapshot en warmup_health_history
 *   4. Escanea alertas predictivas y persiste las nuevas en warmup_alerts
 *
 * Diseñado para ser invocado una vez por día desde n8n (00:05).
 * También puede llamarse manualmente desde el dashboard.
 *
 * Seguridad: X-Warmup-Secret o RBAC warmup:update.
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { getDailyLimitForDay } from '@/lib/warmup-engine'
import { warmingOrchestratorService } from '@/lib/services/warming/warming-orchestrator.service'
import { predictiveAlertService } from '@/lib/services/warming/predictive-alert.service'
import type { OrchestratorLineInput } from '@/lib/services/warming/warming-orchestrator.service'
import type { AlertLineInput } from '@/lib/services/warming/predictive-alert.service'
import type { DelayPreset } from '@/lib/warmup-engine'

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

interface RecentHistoryRow {
  warmup_number_id: string
  score:            number
  recorded_at:      string
}

interface ActiveAlertRow {
  warmup_number_id: string
  type:             string
}

export async function POST(req: NextRequest) {
  const secret = process.env.WARMUP_PROCESS_SECRET
  if (secret && req.headers.get('x-warmup-secret') !== secret) {
    const permErr = await checkPermission(req, 'warmup', 'update')
    if (permErr) return permErr
  }

  const startedAt = Date.now()

  try {
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

    const ids      = lines.map(l => l.id)
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

    // 1. Actualizar health_score en warmup_numbers
    const scoreIds    = result.lines.map(r => r.lineId)
    const scoreValues = result.lines.map(r => r.health.score)

    await query(`
      UPDATE warmup_numbers AS w
      SET    health_score      = v.score::integer,
             health_updated_at = NOW()
      FROM   unnest($1::uuid[], $2::integer[]) AS v(id, score)
      WHERE  w.id = v.id
    `, [scoreIds, scoreValues])

    // 2. Insertar snapshot en warmup_health_history
    const histIds        = result.lines.map(r => r.lineId)
    const histScores     = result.lines.map(r => r.health.score)
    const histComponents = result.lines.map(r => JSON.stringify(r.health.components))
    const histQuotas     = result.lines.map(r => r.schedule.dailyQuota)
    const histSent       = result.lines.map(r => {
      const line = lines.find(l => l.id === r.lineId)
      return line?.messages_sent_today ?? 0
    })

    await query(`
      INSERT INTO warmup_health_history
        (warmup_number_id, score, components, daily_quota, messages_sent)
      SELECT v.id, v.score, v.components::jsonb, v.daily_quota, v.messages_sent
      FROM   unnest(
               $1::uuid[], $2::integer[], $3::text[],
               $4::integer[], $5::integer[]
             ) AS v(id, score, components, daily_quota, messages_sent)
    `, [histIds, histScores, histComponents, histQuotas, histSent])

    // 3. Escanear alertas predictivas ─────────────────────────────────────────

    // Obtener historial reciente (últimos 3 snapshots por línea) para health_drop
    const recentHistory = await query<RecentHistoryRow>(`
      SELECT DISTINCT ON (warmup_number_id) warmup_number_id, score, recorded_at
      FROM   warmup_health_history
      WHERE  warmup_number_id = ANY($1::uuid[])
      ORDER  BY warmup_number_id, recorded_at DESC
    `, [ids])

    // Agrupar historial por línea (máx 3 puntos, más reciente primero)
    const historyByLine = new Map<string, Array<{ score: number; recordedAt: string }>>()
    for (const r of recentHistory) {
      const existing = historyByLine.get(r.warmup_number_id) ?? []
      if (existing.length < 3) existing.push({ score: r.score, recordedAt: r.recorded_at })
      historyByLine.set(r.warmup_number_id, existing)
    }

    // Alertas ya activas (para evitar duplicados)
    const activeAlerts = await query<ActiveAlertRow>(`
      SELECT warmup_number_id, type
      FROM   warmup_alerts
      WHERE  warmup_number_id = ANY($1::uuid[])
        AND  resolved_at IS NULL
    `, [ids])

    const activeAlertSet = new Set(activeAlerts.map(a => `${a.warmup_number_id}:${a.type}`))

    // Detectar y acumular nuevas alertas
    const alertLineIds:   string[] = []
    const alertSeverities: string[] = []
    const alertTypes:     string[] = []
    const alertMessages:  string[] = []
    const alertDataArr:   string[] = []

    for (const orchLine of result.lines) {
      const srcLine = lines.find(l => l.id === orchLine.lineId)
      if (!srcLine) continue

      const alertInput: AlertLineInput = {
        lineId:               orchLine.lineId,
        warmup_status:        srcLine.warmup_status,
        health_score:         orchLine.health.score,
        daysSinceLastMessage: srcLine.last_message_at
          ? (now - new Date(srcLine.last_message_at).getTime()) / 86_400_000
          : 0,
        recent7days:          statsByLine.get(orchLine.lineId) ?? [],
        recentHistory:        historyByLine.get(orchLine.lineId) ?? [],
      }

      const detected = predictiveAlertService.detectAlerts(alertInput)

      for (const alert of detected) {
        const key = `${orchLine.lineId}:${alert.type}`
        if (activeAlertSet.has(key)) continue  // ya existe una activa del mismo tipo

        alertLineIds.push(orchLine.lineId)
        alertSeverities.push(alert.severity)
        alertTypes.push(alert.type)
        alertMessages.push(alert.message)
        alertDataArr.push(JSON.stringify(alert.data))
        activeAlertSet.add(key)  // prevenir duplicados en el mismo batch
      }
    }

    if (alertLineIds.length > 0) {
      await query(`
        INSERT INTO warmup_alerts (warmup_number_id, severity, type, message, data)
        SELECT v.line_id, v.severity, v.type, v.message, v.data::jsonb
        FROM   unnest(
                 $1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[]
               ) AS v(line_id, severity, type, message, data)
      `, [alertLineIds, alertSeverities, alertTypes, alertMessages, alertDataArr])
    }

    const elapsed = Date.now() - startedAt
    console.info(`[POST /api/warmup/orchestrator/run] ${result.lines.length} líneas · ${alertLineIds.length} alertas en ${elapsed}ms`)

    return NextResponse.json({
      ok:                  true,
      updated:             result.lines.length,
      alertsGenerated:     alertLineIds.length,
      totalActiveLines:    result.totalActiveLines,
      totalDailyQuota:     result.totalDailyQuota,
      totalRemainingToday: result.totalRemainingToday,
      elapsed_ms:          elapsed,
      lines: result.lines.map(r => ({
        id:               r.lineId,
        health_score:     r.health.score,
        daily_quota:      r.schedule.dailyQuota,
        should_send:      r.schedule.shouldSendToday,
        weight:           r.weight,
      })),
    })

  } catch (e) {
    console.error('[POST /api/warmup/orchestrator/run]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
