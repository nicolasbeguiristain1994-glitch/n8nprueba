/**
 * POST /api/warmup/process
 *
 * Motor principal de calentamiento. Debe ser invocado cada 15 minutos por
 * un nodo HTTP de n8n (o cualquier cron externo).
 *
 * Flujo por invocación:
 *   1. Obtiene líneas activas con capacidad restante en el día.
 *   2. Para cada línea aplica las guardas en orden:
 *      a. [anti-ban] Día activo  → si el día no está en active_days, pospone.
 *      b. Ventana horaria        → si anti_ban_enabled usa la ventana configurable,
 *                                  si no usa el bloque fijo 9-20h.
 *      c. [anti-ban] Cooldown    → comprueba que haya transcurrido el delay mínimo
 *                                  desde last_message_at antes de volver a enviar.
 *      d. Batch size probabilístico → decide cuántos mensajes enviar.
 *      e. [anti-ban] Cap a 1 msg  → cuando anti-ban está activo, envía máximo
 *                                   1 mensaje por batch para no bloquear el handler.
 *   3. Envía via Evolution API, registra en warmup_activity_log y actualiza contadores.
 *   4. Devuelve resumen estructurado.
 *
 * Por qué cooldown en lugar de sleep:
 *   El endpoint es llamado por n8n, que tiene un timeout HTTP de ~30 s.
 *   Los delays anti-ban (45–3 600 s) superan ese límite. En cambio, comparar
 *   now − last_message_at con el delay requerido es instantáneo y permite que
 *   cada invocación del cron actúe como "tick" de scheduler.
 *
 * Compatibilidad:
 *   Líneas sin los campos anti-ban (columnas NULL) usan el comportamiento
 *   legacy: ventana 9-20 h, sin cooldown, hasta 2 mensajes por batch.
 *
 * Seguridad:
 *   Requiere header X-Warmup-Secret == env WARMUP_PROCESS_SECRET.
 *   Si la variable no está configurada, acepta todas las llamadas (modo dev).
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import {
  getDailyLimitForDay,
  isActiveHour,
  isActiveWindow,
  remainingActiveSlots,
  remainingWindowSlots,
  isActiveDay,
  getAntiBanDelayMs,
  decideBatchSize,
  getNextWarmupMessage,
  type RandomnessLevel,
} from '@/lib/warmup-engine'

// ── Constantes ────────────────────────────────────────────────────────────────

/** Máximo de líneas procesadas por invocación (evita timeouts de Next.js). */
const MAX_LINES_PER_BATCH = 10

// ── Tipos internos ────────────────────────────────────────────────────────────

interface WarmupLine {
  id:                   string
  instance_name:        string
  evolution_url:        string | null
  messages_sent_today:  number
  current_day:          number
  target_days:          number
  timezone:             string
  last_message_at:      string | null
  delay_preset:         string
  // Anti-ban fields (nullable → NULL means feature not configured yet)
  anti_ban_enabled:     boolean | null
  delay_min_seconds:    number  | null
  delay_max_seconds:    number  | null
  sending_window_start: string  | null
  sending_window_end:   string  | null
  active_days:          number[]| null
  randomness_level:     string  | null
  natural_distribution: boolean | null
}

interface WarmupContact {
  id:           string
  phone_number: string
}

interface LineResult {
  line_id:      string
  instance:     string
  sent:         number
  skipped:      boolean
  skip_reason?: string
  anti_ban:     boolean
  errors:       string[]
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Autenticación ligera ──────────────────────────────────────────────────
  const secret = process.env.WARMUP_PROCESS_SECRET
  if (secret) {
    if (req.headers.get('x-warmup-secret') !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  } else {
    console.warn('[warmup/process] WARMUP_PROCESS_SECRET no configurado — endpoint sin autenticación')
  }

  const evolutionUrl = process.env.EVOLUTION_URL
  const apiKey       = process.env.EVOLUTION_API_KEY

  if (!evolutionUrl || !apiKey) {
    return NextResponse.json(
      { error: 'EVOLUTION_URL y EVOLUTION_API_KEY son requeridos' },
      { status: 500 }
    )
  }

  const now     = new Date()
  const results: LineResult[] = []
  let totalSent = 0

  try {
    // ── 1. Obtener líneas activas candidatas ──────────────────────────────
    const lines = await query<WarmupLine>(`
      SELECT id, instance_name, evolution_url,
             messages_sent_today, current_day, target_days, timezone,
             last_message_at,
             COALESCE(delay_preset, 'normal') AS delay_preset,
             anti_ban_enabled,
             delay_min_seconds, delay_max_seconds,
             sending_window_start::text, sending_window_end::text,
             active_days, randomness_level, natural_distribution
      FROM   warmup_numbers
      WHERE  warmup_status = 'active'
      ORDER  BY messages_sent_today ASC, last_message_at ASC NULLS FIRST
      LIMIT  $1
    `, [MAX_LINES_PER_BATCH])

    for (const line of lines) {
      const antiBanActive = line.anti_ban_enabled === true
      const result: LineResult = {
        line_id:  line.id,
        instance: line.instance_name,
        sent:     0,
        skipped:  false,
        anti_ban: antiBanActive,
        errors:   [],
      }

      // ── 2a. [anti-ban] Verificar día activo ───────────────────────────────
      if (antiBanActive && line.active_days && line.active_days.length > 0) {
        if (!isActiveDay(line.active_days, line.timezone, now)) {
          const dow = new Intl.DateTimeFormat('es-AR', { weekday: 'long', timeZone: line.timezone }).format(now)
          console.info(`[warmup/process] [anti-ban] ${line.instance_name}: día no activo (${dow})`)
          result.skipped     = true
          result.skip_reason = 'inactive_day'
          results.push(result)
          continue
        }
      }

      // ── 2b. Verificar ventana horaria ─────────────────────────────────────
      const windowStart = line.sending_window_start ?? '09:00'
      const windowEnd   = line.sending_window_end   ?? '20:00'

      const inWindow = antiBanActive
        ? isActiveWindow(windowStart, windowEnd, line.timezone, now)
        : isActiveHour(line.timezone, now)

      if (!inWindow) {
        console.info(`[warmup/process] ${antiBanActive ? '[anti-ban] ' : ''}${line.instance_name}: fuera de ventana horaria (${windowStart}–${windowEnd})`)
        result.skipped     = true
        result.skip_reason = 'outside_active_hours'
        results.push(result)
        continue
      }

      // ── 2c. [anti-ban] Verificar cooldown desde último mensaje ─────────────
      if (antiBanActive && line.last_message_at) {
        const minDelay   = line.delay_min_seconds    ?? 45
        const maxDelay   = line.delay_max_seconds    ?? 180
        const level      = (line.randomness_level    ?? 'medium') as RandomnessLevel
        const naturalDist = line.natural_distribution ?? false

        const requiredDelayMs = getAntiBanDelayMs(
          minDelay, maxDelay, level, naturalDist,
          windowStart, windowEnd, line.timezone, now,
        )
        const elapsedMs = now.getTime() - new Date(line.last_message_at).getTime()

        if (elapsedMs < requiredDelayMs) {
          const elapsedS  = Math.round(elapsedMs / 1000)
          const requiredS = Math.round(requiredDelayMs / 1000)
          console.info(
            `[warmup/process] [anti-ban] ${line.instance_name}: cooldown activo ` +
            `(${elapsedS}s transcurrido < ${requiredS}s requerido, nivel=${level})`
          )
          result.skipped     = true
          result.skip_reason = 'anti_ban_cooldown'
          results.push(result)
          continue
        }
      }

      // ── 3. Calcular límite efectivo del día ───────────────────────────────
      const effectiveLimit = getDailyLimitForDay(line.current_day, line.target_days)
      const remaining      = effectiveLimit - line.messages_sent_today

      if (remaining <= 0) {
        result.skipped     = true
        result.skip_reason = 'daily_limit_reached'
        results.push(result)
        continue
      }

      // ── 4. Decidir cuántos mensajes enviar en este batch ──────────────────
      const slots = antiBanActive
        ? remainingWindowSlots(windowStart, windowEnd, line.timezone, now)
        : remainingActiveSlots(line.timezone, now)

      const decision = decideBatchSize(remaining, slots)

      if (!decision.shouldSend) {
        result.skipped     = true
        result.skip_reason = 'probabilistic_skip'
        results.push(result)
        continue
      }

      // Anti-ban: cap to 1 message per run.
      // n8n's HTTP node typically times out in ~30 s; sleeping between messages
      // (to honor delay_min_seconds) would fail for delays > 30 s. Instead, each
      // cron tick sends at most 1 message and the cooldown guard at the top of
      // the next tick enforces the required inter-message spacing — no sleep needed.
      const batchCount = antiBanActive ? Math.min(decision.count, 1) : decision.count

      // ── 5. Resolver Evolution URL ─────────────────────────────────────────
      const evoUrl = line.evolution_url ?? evolutionUrl

      // ── 6. Enviar mensajes del batch ──────────────────────────────────────
      for (let i = 0; i < batchCount; i++) {
        // 6a. Seleccionar próximo contacto (menos usado, más antiguo)
        const contacts = await query<WarmupContact>(`
          SELECT id, phone_number
          FROM   warmup_contacts
          WHERE  is_active = true
          ORDER  BY message_count ASC, last_used_at ASC NULLS FIRST
          LIMIT  1
        `)

        if (!contacts.length) {
          result.errors.push('No hay contactos de warmup disponibles')
          break
        }

        const contact = contacts[0]
        const msgData = getNextWarmupMessage(line.id, line.current_day <= 7 ? 'foundation' : line.current_day <= 14 ? 'growth' : 'maturity')

        // 6b. Enviar via Evolution
        let sendOk      = false
        let evolutionErr = ''
        try {
          const evoRes = await fetch(
            `${evoUrl}/message/sendText/${line.instance_name}`,
            {
              method:  'POST',
              headers: { 'Content-Type': 'application/json', apikey: apiKey },
              body:    JSON.stringify({ number: contact.phone_number, text: msgData.content }),
              signal:  AbortSignal.timeout(15_000),
            }
          )
          if (evoRes.ok) {
            sendOk = true
          } else {
            let errText: string
            try {
              const d = await evoRes.json()
              errText = (d?.message as string) || String(evoRes.status)
            } catch {
              errText = String(evoRes.status)
            }
            evolutionErr = `Evolution ${evoRes.status}: ${errText}`
          }
        } catch (fetchErr) {
          evolutionErr = fetchErr instanceof Error ? fetchErr.message : 'fetch error'
        }

        const status = sendOk ? 'sent' : 'failed'

        // 6c. Registrar en warmup_activity_log
        try {
          await query(`
            INSERT INTO warmup_activity_log
              (warmup_number_id, phone_number, recipient, message_type, message_preview, status, warmup_day)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [
            line.id,
            line.instance_name,
            contact.phone_number,
            msgData.type,
            msgData.content.slice(0, 200),
            status,
            line.current_day,
          ])
        } catch (logErr) {
          console.error('[warmup/process] error insertando log:', logErr instanceof Error ? logErr.message : logErr)
        }

        if (!sendOk) {
          result.errors.push(evolutionErr)
          console.warn(`[warmup/process] ${line.instance_name}: fallo de envío — ${evolutionErr}`)
          continue
        }

        // 6d. Incrementar contador en warmup_numbers
        await query(`
          UPDATE warmup_numbers
          SET    messages_sent_today = messages_sent_today + 1,
                 last_message_at    = NOW(),
                 updated_at         = NOW()
          WHERE  id = $1
        `, [line.id])

        // 6e. Actualizar contacto
        await query(`
          UPDATE warmup_contacts
          SET    message_count = message_count + 1,
                 last_used_at  = NOW()
          WHERE  id = $1
        `, [contact.id])

        result.sent++
        totalSent++

        console.info(
          `[warmup/process] ${antiBanActive ? '[anti-ban] ' : ''}${line.instance_name}: ` +
          `mensaje enviado a ${contact.phone_number} (día ${line.current_day}, msg ${line.messages_sent_today + result.sent}/${effectiveLimit})`
        )
      }

      results.push(result)
    }

    return NextResponse.json({
      ok:         true,
      processed:  lines.length,
      total_sent: totalSent,
      timestamp:  now.toISOString(),
      lines:      results,
    })

  } catch (e) {
    console.error('[warmup/process POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
