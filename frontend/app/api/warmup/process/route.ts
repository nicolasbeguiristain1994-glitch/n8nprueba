/**
 * POST /api/warmup/process
 *
 * Motor principal de calentamiento. Debe ser invocado cada 15 minutos por
 * un nodo HTTP de n8n (o cualquier cron externo).
 *
 * Por cada invocación:
 *   1. Obtiene todas las líneas con warmup_status = 'active' que aún tienen
 *      capacidad en el día y están dentro del horario activo (9am–8pm).
 *   2. Para cada línea, decide probabilísticamente cuántos mensajes enviar
 *      en este batch (0, 1 ó 2) usando la función decideBatchSize().
 *   3. Por cada mensaje a enviar:
 *      a. Selecciona el próximo contacto de warmup_contacts (menor uso).
 *      b. Envía via Evolution API.
 *      c. Registra en warmup_activity_log.
 *      d. Incrementa messages_sent_today y actualiza last_message_at.
 *      e. Actualiza message_count y last_used_at del contacto.
 *   4. Devuelve un resumen de lo que se envió.
 *
 * Seguridad:
 *   Requiere header X-Warmup-Secret que debe coincidir con la variable
 *   de entorno WARMUP_PROCESS_SECRET. Si la variable no está configurada
 *   el endpoint acepta todas las llamadas (para facilitar la configuración
 *   inicial), pero logea una advertencia.
 *
 * Límites de tiempo:
 *   Máximo 10 líneas procesadas por invocación para evitar timeouts de
 *   Next.js. Con 15 líneas activas y 15-min de cadencia, todas las líneas
 *   se procesan en cada ciclo.
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import {
  getDailyLimitForDay,
  isActiveHour,
  remainingActiveSlots,
  decideBatchSize,
  pickWarmupMessage,
} from '@/lib/warmup-engine'

// ── Constantes ────────────────────────────────────────────────────────────────

const MAX_LINES_PER_BATCH = 10

// ── Tipos internos ────────────────────────────────────────────────────────────

interface WarmupLine {
  id:                 string
  instance_name:      string
  evolution_url:      string | null
  messages_sent_today: number
  current_day:        number
  target_days:        number
  timezone:           string
}

interface WarmupContact {
  id:           string
  phone_number: string
}

interface LineResult {
  line_id:       string
  instance:      string
  sent:          number
  skipped:       boolean
  skip_reason?:  string
  errors:        string[]
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Autenticación ligera ──────────────────────────────────────────────────
  const secret = process.env.WARMUP_PROCESS_SECRET
  if (secret) {
    const provided = req.headers.get('x-warmup-secret')
    if (provided !== secret) {
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
             messages_sent_today, current_day, target_days, timezone
      FROM   warmup_numbers
      WHERE  warmup_status = 'active'
      ORDER  BY messages_sent_today ASC, last_message_at ASC NULLS FIRST
      LIMIT  $1
    `, [MAX_LINES_PER_BATCH])

    for (const line of lines) {
      const result: LineResult = {
        line_id:  line.id,
        instance: line.instance_name,
        sent:     0,
        skipped:  false,
        errors:   [],
      }

      // ── 2. Verificar horario activo ─────────────────────────────────────
      if (!isActiveHour(line.timezone, now)) {
        result.skipped     = true
        result.skip_reason = 'outside_active_hours'
        results.push(result)
        continue
      }

      // ── 3. Calcular límite efectivo del día ─────────────────────────────
      const effectiveLimit = getDailyLimitForDay(line.current_day, line.target_days)
      const remaining      = effectiveLimit - line.messages_sent_today

      if (remaining <= 0) {
        result.skipped     = true
        result.skip_reason = 'daily_limit_reached'
        results.push(result)
        continue
      }

      // ── 4. Decidir cuántos mensajes enviar en este batch ────────────────
      const slots    = remainingActiveSlots(line.timezone, now)
      const decision = decideBatchSize(remaining, slots)

      if (!decision.shouldSend) {
        result.skipped     = true
        result.skip_reason = 'probabilistic_skip'
        results.push(result)
        continue
      }

      // ── 5. Resolver Evolution URL ───────────────────────────────────────
      const evoUrl = line.evolution_url ?? evolutionUrl

      // ── 6. Enviar mensajes del batch ────────────────────────────────────
      for (let i = 0; i < decision.count; i++) {
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
        const msgData = pickWarmupMessage(line.current_day, line.messages_sent_today + i)

        // 6b. Enviar via Evolution
        let sendOk    = false
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
          // No detenemos el batch por un error — intentamos el siguiente mensaje
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

        // 6e. Actualizar contacto (marcar como usado)
        await query(`
          UPDATE warmup_contacts
          SET    message_count = message_count + 1,
                 last_used_at  = NOW()
          WHERE  id = $1
        `, [contact.id])

        result.sent++
        totalSent++
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
