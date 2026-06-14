/**
 * POST /api/warmup/daily-reset
 *
 * Reset diario del módulo de calentamiento:
 *   1. Resetea messages_sent_today = 0 en activas y pausadas.
 *   2. Incrementa current_day en líneas activas que aún no terminaron.
 *   3. Marca como 'completed' las que alcanzaron target_days.
 *
 * Invocar UNA VEZ POR DÍA a las 00:00 UTC desde n8n.
 *
 * ── IMPORTANTE: orden de operaciones con el orchestrator ────────────────────
 *   El health score usa messages_sent_today. Para que el snapshot diario
 *   refleje los envíos REALES del día anterior, el orchestrator/run debe
 *   ejecutarse ANTES que este reset.
 *
 *   Orden correcto del cron en n8n:
 *     23:55 UTC → POST /api/warmup/orchestrator/run  (snapshot con datos reales)
 *     00:00 UTC → POST /api/warmup/daily-reset       (reset de contadores)
 *
 * ── Idempotencia (Fix 5) ─────────────────────────────────────────────────────
 *   Si n8n reintenta la llamada (retry por timeout u otro error), una segunda
 *   ejecución en el mismo día incrementaría current_day dos veces.
 *
 *   Solución: lock en Redis con SET NX EX 26h.
 *   - Si Redis está disponible: la segunda ejecución detecta el lock y retorna
 *     { ok: true, skipped: true } sin tocar la DB.
 *   - Si Redis no está disponible: se ejecuta normalmente (comportamiento anterior).
 *     El riesgo de doble-incremento es aceptable como fallback de degradación.
 */

import { NextRequest, NextResponse } from 'next/server'
import { query }                     from '@/lib/db'
import { getConfigRedisClient }      from '@/lib/redis'

// Clave Redis de idempotencia: warmup:daily-reset:YYYY-MM-DD
// TTL 26h: cubre el día completo + 2h de margen de seguridad.
const RESET_LOCK_TTL_SECS = 26 * 3600

function buildLockKey(): string {
  return `warmup:daily-reset:${new Date().toISOString().slice(0, 10)}`
}

export async function POST(req: NextRequest) {
  // ── Autenticación ligera ────────────────────────────────────────────────────
  const secret = process.env.WARMUP_PROCESS_SECRET
  if (secret) {
    if (req.headers.get('x-warmup-secret') !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  // ── Guard de idempotencia via Redis ─────────────────────────────────────────
  const redis   = getConfigRedisClient()
  const lockKey = buildLockKey()

  if (redis) {
    try {
      // SET NX: solo setea si no existe la clave → retorna 'OK' o null
      const acquired = await redis.set(lockKey, '1', { NX: true, EX: RESET_LOCK_TTL_SECS })
      if (acquired === null) {
        // La clave ya existía → el reset ya se ejecutó hoy
        console.info(`[warmup/daily-reset] ya ejecutado hoy (${lockKey}) — skipping`)
        return NextResponse.json({
          ok:      true,
          skipped: true,
          reason:  'already_run_today',
          lock:    lockKey,
        })
      }
      // acquired === 'OK' → lock adquirido, proceder con el reset
    } catch (redisErr) {
      // Redis no disponible → proceder sin protección (degradación aceptable)
      console.warn(
        '[warmup/daily-reset] Redis no disponible para idempotencia — ejecutando sin lock:',
        redisErr instanceof Error ? redisErr.message : redisErr,
      )
    }
  }

  try {
    // ── 1. Reset de messages_sent_today ──────────────────────────────────────
    // Activas + pausadas: ambas necesitan el reset para el día siguiente.
    const resetResult = await query<{ id: string }>(`
      UPDATE warmup_numbers
      SET    messages_sent_today = 0,
             updated_at          = NOW()
      WHERE  warmup_status IN ('active', 'paused')
      RETURNING id
    `)
    const resetCount = resetResult.length

    // ── 2. Marcar completadas las que alcanzaron target_days ─────────────────
    // Ejecutar ANTES de incrementar para evitar que current_day supere target_days
    // en el caso borde donde current_day = target_days - 1 (llegaría a target_days
    // con el incremento, debería quedar completed, no seguir).
    const completedResult = await query<{ id: string; instance_name: string }>(`
      UPDATE warmup_numbers
      SET    warmup_status = 'completed',
             updated_at    = NOW()
      WHERE  warmup_status = 'active'
        AND  current_day  >= target_days
      RETURNING id, instance_name
    `)
    const completedCount     = completedResult.length
    const completedInstances = completedResult.map(r => r.instance_name)

    // ── 3. Incrementar current_day en las que continúan ──────────────────────
    const incrementResult = await query<{ id: string }>(`
      UPDATE warmup_numbers
      SET    current_day = current_day + 1,
             updated_at  = NOW()
      WHERE  warmup_status = 'active'
        AND  current_day  < target_days
      RETURNING id
    `)
    const incrementCount = incrementResult.length

    console.log(
      `[warmup/daily-reset] reset=${resetCount} | ` +
      `incrementado=${incrementCount} | completado=${completedCount}`,
    )

    return NextResponse.json({
      ok:                  true,
      skipped:             false,
      reset_count:         resetCount,
      incremented_count:   incrementCount,
      completed_count:     completedCount,
      completed_instances: completedInstances,
      timestamp:           new Date().toISOString(),
    })

  } catch (err) {
    // Si el reset falla después de adquirir el lock, liberar el lock para
    // que n8n pueda reintentar exitosamente.
    if (redis) {
      try { await redis.del(lockKey) } catch { /* non-fatal */ }
    }
    console.error('[warmup/daily-reset POST]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
