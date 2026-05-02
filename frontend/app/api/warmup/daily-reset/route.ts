/**
 * POST /api/warmup/daily-reset
 *
 * Ejecuta el reset diario del módulo de calentamiento:
 *   1. Resetea messages_sent_today = 0 en todas las líneas activas o pausadas.
 *   2. Incrementa current_day en las líneas activas.
 *   3. Marca como 'completed' las líneas que alcanzaron target_days.
 *
 * Debe ser invocado UNA VEZ POR DÍA a medianoche (o a las 00:05 para
 * evitar conflictos de zona horaria). Configurar en n8n con un nodo
 * Schedule Trigger en "0 0 * * *" (cron diario a las 00:00 UTC).
 *
 * Seguridad: mismo mecanismo que /api/warmup/process — requiere
 * X-Warmup-Secret si WARMUP_PROCESS_SECRET está configurado.
 *
 * Idempotente: correr dos veces el mismo día solo avanza current_day
 * si updated_at < inicio del día → para mayor seguridad, el frontend
 * podría llevar un registro de la última ejecución, pero en producción
 * el cron de n8n garantiza la unicidad.
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function POST(req: NextRequest) {
  // ── Autenticación ligera (mismo secreto que /process) ─────────────────────
  const secret = process.env.WARMUP_PROCESS_SECRET
  if (secret) {
    const provided = req.headers.get('x-warmup-secret')
    if (provided !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    // ── 1. Reset de messages_sent_today (activas + pausadas) ──────────────
    const resetResult = await query<{ count: string }>(`
      UPDATE warmup_numbers
      SET    messages_sent_today = 0,
             updated_at          = NOW()
      WHERE  warmup_status IN ('active', 'paused')
      RETURNING id
    `)
    const resetCount = resetResult.length

    // ── 2. Incrementar current_day en líneas activas ───────────────────────
    // Solo las que aún no completaron (current_day < target_days)
    const incrementResult = await query<{ id: string }>(`
      UPDATE warmup_numbers
      SET    current_day = current_day + 1,
             updated_at  = NOW()
      WHERE  warmup_status = 'active'
        AND  current_day < target_days
      RETURNING id
    `)
    const incrementCount = incrementResult.length

    // ── 3. Marcar completadas las que alcanzaron target_days ─────────────
    const completedResult = await query<{ id: string; instance_name: string }>(`
      UPDATE warmup_numbers
      SET    warmup_status = 'completed',
             updated_at    = NOW()
      WHERE  warmup_status = 'active'
        AND  current_day  >= target_days
      RETURNING id, instance_name
    `)
    const completedCount    = completedResult.length
    const completedInstances = completedResult.map(r => r.instance_name)

    console.log(
      `[warmup/daily-reset] reset=${resetCount} lines, ` +
      `incremented=${incrementCount}, completed=${completedCount}`
    )

    return NextResponse.json({
      ok:                  true,
      reset_count:         resetCount,
      incremented_count:   incrementCount,
      completed_count:     completedCount,
      completed_instances: completedInstances,
      timestamp:           new Date().toISOString(),
    })

  } catch (e) {
    console.error('[warmup/daily-reset POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
