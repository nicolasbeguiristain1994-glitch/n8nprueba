/**
 * POST /api/warmup/process  (v2)
 *
 * Motor principal de calentamiento. Invocado cada 15 minutos por n8n.
 *
 * ── Cambios respecto a v1 ────────────────────────────────────────────────────
 *
 *  Fix 1 — Contactos por línea
 *    Cada línea usa sus propios contactos (assigned_line_id). Si no tiene
 *    asignados, se auto-asigna uno del pool global con FOR UPDATE SKIP LOCKED
 *    (seguro ante invocaciones concurrentes). Antes: todas las líneas
 *    compartían el mismo pool → el contacto menos usado recibía mensajes de
 *    30 números distintos el mismo día (señal de spam coordinado para Meta).
 *
 *  Fix 2 — Historial de rotación via Redis
 *    Los mensajes recientes se leen/escriben en Redis (warmup-rotation.ts).
 *    Antes: Map en memoria → vacío en cada cold start de serverless → el mismo
 *    texto podía enviarse en invocaciones consecutivas.
 *
 *  Fix 3 — Atomicidad via RPC
 *    Las 3-4 queries separadas por mensaje (INSERT log + UPDATE counter +
 *    UPDATE contact) se reemplazan por una sola llamada a
 *    warmup_record_activity() (migración 065). Elimina la race condition donde
 *    dos invocaciones paralelas leían el mismo messages_sent_today y ambas
 *    superaban el límite diario.
 *
 *  Fix 4 — Detección de bans + circuit breaker
 *    classifyEvoError() parsea la respuesta de Evolution API y distingue
 *    permanent_ban / temporary_block / rate_limited / network_error.
 *    Ban permanente → warmup_status = 'banned' inmediato.
 *    Circuit breaker: si las últimas CB_THRESHOLD actividades son todas
 *    fallidas → la línea se pausa automáticamente.
 *
 *  Fix 5 — Capacidad para pools grandes
 *    MAX_LINES_PER_BATCH subió a 50 (antes 10). Con 30 líneas el LIMIT
 *    anterior cortaba 2/3 del pool en cada tick; las líneas 11-30 nunca
 *    alcanzaban su cuota diaria, degradando su health score falsamente.
 *
 * ── Por qué cooldown en lugar de sleep ──────────────────────────────────────
 *    n8n tiene un timeout HTTP de ~30 s. Los delays anti-ban (45–3600 s)
 *    superan ese límite. Comparar now − last_message_at con el delay requerido
 *    es instantáneo y convierte cada tick del cron en un "scheduler tick".
 */

import { NextRequest, NextResponse } from 'next/server'
import { query }                     from '@/lib/db'
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
  getWarmupPhase,
  type RandomnessLevel,
} from '@/lib/warmup-engine'
import {
  getRecentMessages,
  recordSentMessage,
} from '@/lib/warmup-rotation'

// ── Constantes ─────────────────────────────────────────────────────────────────

/** Máximo de líneas procesadas por invocación. 50 cubre un pool de 30+ líneas. */
const MAX_LINES_PER_BATCH = 50

/**
 * Circuit breaker: si las últimas CB_THRESHOLD entradas en warmup_activity_log
 * son todas 'failed' o 'banned', la línea se pausa automáticamente.
 */
const CB_THRESHOLD = 3

// ── Tipos ──────────────────────────────────────────────────────────────────────

interface WarmupLine {
  id:                   string
  phone_number:         string   // número real de la línea (para el RPC)
  instance_name:        string   // nombre de instancia en Evolution API
  evolution_url:        string | null
  messages_sent_today:  number
  current_day:          number
  target_days:          number
  timezone:             string
  last_message_at:      string | null
  delay_preset:         string
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

type EvoErrorType = 'permanent_ban' | 'temporary_block' | 'rate_limited' | 'network_error'

interface LineResult {
  line_id:      string
  instance:     string
  sent:         number
  skipped:      boolean
  skip_reason?: string
  anti_ban:     boolean
  errors:       string[]
}

// ── Clasificación de errores de Evolution API ─────────────────────────────────

/**
 * Clasifica el error de Evolution en una de las 4 categorías del schema
 * (columna error_type de warmup_activity_log, migración 065).
 *
 * Señales de ban permanente (el número fue baneado por WhatsApp):
 *   - HTTP 401/403 con mensajes específicos de ban
 *   - Cuerpo que contiene 'banned', 'suspended', 'forbidden account'
 *
 * Se es conservador: en caso de duda se clasifica como temporary_block,
 * no como permanent_ban, para evitar false positives que marquen la línea.
 */
function classifyEvoError(httpStatus: number, responseBody: string): EvoErrorType {
  const body = responseBody.toLowerCase()

  // Señales explícitas de ban permanente del número
  if (
    body.includes('banned')            ||
    body.includes('suspended')         ||
    body.includes('forbidden account') ||
    body.includes('account blocked')
  ) {
    return 'permanent_ban'
  }

  // Rate limiting — no implica ban, solo backoff
  if (httpStatus === 429 || body.includes('rate limit') || body.includes('too many requests')) {
    return 'rate_limited'
  }

  // Errores de servidor (Evolution caído, timeout interno)
  if (httpStatus >= 500) return 'network_error'

  // Resto de 4xx → bloqueo temporal (instancia desconectada, QR no escaneado, etc.)
  return 'temporary_block'
}

// ── Resolución de contacto por línea ─────────────────────────────────────────

/**
 * Obtiene el contacto más apropiado para esta línea:
 *
 *  Paso 1 — Contacto ya asignado a esta línea (least-recently-used primero).
 *  Paso 2 — Auto-asignar uno del pool global si la línea no tiene asignados.
 *            FOR UPDATE SKIP LOCKED evita que dos invocaciones concurrentes
 *            tomen el mismo contacto.
 *
 * Retorna null si no hay contactos disponibles en ninguno de los dos pasos.
 */
async function resolveContact(lineId: string): Promise<WarmupContact | null> {
  // Paso 1: contacto asignado + menos usado recientemente
  const assigned = await query<WarmupContact>(`
    SELECT id, phone_number
    FROM   warmup_contacts
    WHERE  is_active       = true
      AND  assigned_line_id = $1
    ORDER  BY last_used_at ASC NULLS FIRST,
              message_count  ASC
    LIMIT  1
  `, [lineId])

  if (assigned.length > 0) return assigned[0]

  // Paso 2: auto-asignar del pool global (atómico)
  const autoAssigned = await query<WarmupContact>(`
    UPDATE warmup_contacts
    SET    assigned_line_id = $1
    WHERE  id = (
      SELECT id
      FROM   warmup_contacts
      WHERE  is_active        = true
        AND  assigned_line_id IS NULL
      ORDER  BY message_count ASC
      LIMIT  1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, phone_number
  `, [lineId])

  return autoAssigned.length > 0 ? autoAssigned[0] : null
}

// ── Verificación del circuit breaker ─────────────────────────────────────────

/**
 * Retorna true si las últimas CB_THRESHOLD actividades de la línea son
 * todas fallidas (failed o banned). En ese caso se pausa la línea.
 *
 * Consulta solo las últimas CB_THRESHOLD filas del log → O(1) con el índice
 * idx_warmup_log_number_id + sent_at.
 */
async function isCircuitOpen(lineId: string): Promise<boolean> {
  const rows = await query<{ status: string }>(`
    SELECT status
    FROM   warmup_activity_log
    WHERE  warmup_number_id = $1
    ORDER  BY sent_at DESC
    LIMIT  $2
  `, [lineId, CB_THRESHOLD])

  if (rows.length < CB_THRESHOLD) return false   // sin historial suficiente

  return rows.every(r => r.status === 'failed' || r.status === 'banned')
}

// ── Handler principal ─────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {

  // ── Autenticación ligera ────────────────────────────────────────────────────
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
      { status: 500 },
    )
  }

  const now     = new Date()
  const results: LineResult[] = []
  let totalSent = 0

  try {
    // ── 1. Obtener líneas activas candidatas ─────────────────────────────────
    // Sin filtro de cuota en SQL: la cuota se calcula en TS con getDailyLimitForDay()
    // porque depende de current_day y target_days (curva x^0.6).
    // MAX_LINES_PER_BATCH = 50 cubre cualquier pool razonable.
    const lines = await query<WarmupLine>(`
      SELECT id,
             phone_number,
             instance_name,
             evolution_url,
             messages_sent_today,
             current_day,
             target_days,
             COALESCE(timezone, 'America/Argentina/Buenos_Aires') AS timezone,
             last_message_at,
             COALESCE(delay_preset, 'normal') AS delay_preset,
             anti_ban_enabled,
             delay_min_seconds,
             delay_max_seconds,
             sending_window_start::text,
             sending_window_end::text,
             active_days,
             randomness_level,
             natural_distribution
      FROM   warmup_numbers
      WHERE  warmup_status = 'active'
      ORDER  BY messages_sent_today ASC,
                last_message_at     ASC NULLS FIRST
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

      // ── 2a. [anti-ban] Verificar día activo ──────────────────────────────
      if (antiBanActive && line.active_days && line.active_days.length > 0) {
        if (!isActiveDay(line.active_days, line.timezone, now)) {
          const dow = new Intl.DateTimeFormat('es-AR', {
            weekday: 'long', timeZone: line.timezone,
          }).format(now)
          result.skipped     = true
          result.skip_reason = 'inactive_day'
          console.info(`[warmup/process] [anti-ban] ${line.instance_name}: día no activo (${dow})`)
          results.push(result)
          continue
        }
      }

      // ── 2b. Verificar ventana horaria ────────────────────────────────────
      const windowStart = line.sending_window_start ?? '09:00'
      const windowEnd   = line.sending_window_end   ?? '20:00'
      const inWindow    = antiBanActive
        ? isActiveWindow(windowStart, windowEnd, line.timezone, now)
        : isActiveHour(line.timezone, now)

      if (!inWindow) {
        result.skipped     = true
        result.skip_reason = 'outside_active_hours'
        results.push(result)
        continue
      }

      // ── 2c. [anti-ban] Verificar cooldown ────────────────────────────────
      if (antiBanActive && line.last_message_at) {
        const minDelay    = line.delay_min_seconds    ?? 45
        const maxDelay    = line.delay_max_seconds    ?? 180
        const level       = (line.randomness_level    ?? 'medium') as RandomnessLevel
        const naturalDist = line.natural_distribution ?? false

        const requiredDelayMs = getAntiBanDelayMs(
          minDelay, maxDelay, level, naturalDist,
          windowStart, windowEnd, line.timezone, now,
        )
        const elapsedMs = now.getTime() - new Date(line.last_message_at).getTime()

        if (elapsedMs < requiredDelayMs) {
          result.skipped     = true
          result.skip_reason = 'anti_ban_cooldown'
          console.info(
            `[warmup/process] [anti-ban] ${line.instance_name}: cooldown activo ` +
            `(${Math.round(elapsedMs / 1000)}s < ${Math.round(requiredDelayMs / 1000)}s requerido)`,
          )
          results.push(result)
          continue
        }
      }

      // ── 2d. Verificar cuota diaria ───────────────────────────────────────
      const effectiveLimit = getDailyLimitForDay(line.current_day, line.target_days)
      const remaining      = effectiveLimit - line.messages_sent_today

      if (remaining <= 0) {
        result.skipped     = true
        result.skip_reason = 'daily_limit_reached'
        results.push(result)
        continue
      }

      // ── 2e. Circuit breaker ───────────────────────────────────────────────
      // Verificar ANTES de intentar enviar para no acumular más fallos.
      const circuitOpen = await isCircuitOpen(line.id)
      if (circuitOpen) {
        // Pausar la línea automáticamente
        await query(`
          UPDATE warmup_numbers
          SET    warmup_status = 'paused',
                 updated_at    = NOW()
          WHERE  id = $1
        `, [line.id])
        result.skipped     = true
        result.skip_reason = 'circuit_breaker_open'
        result.errors.push(`Circuit breaker: ${CB_THRESHOLD} fallos consecutivos → línea pausada`)
        console.warn(`[warmup/process] ${line.instance_name}: circuit breaker → paused`)
        results.push(result)
        continue
      }

      // ── 3. Decidir cuántos mensajes enviar ───────────────────────────────
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

      // Anti-ban: máximo 1 mensaje por tick. El cooldown garantiza el spacing;
      // dormir entre mensajes haría al handler superar el timeout HTTP de n8n.
      const batchCount = antiBanActive ? Math.min(decision.count, 1) : decision.count

      // ── 4. Resolver Evolution URL ────────────────────────────────────────
      const evoUrl = line.evolution_url ?? evolutionUrl

      // ── 5. Enviar mensajes del batch ─────────────────────────────────────
      for (let i = 0; i < batchCount; i++) {

        // 5a. Contacto asignado a esta línea (Fix 1) ──────────────────────
        const contact = await resolveContact(line.id)

        if (!contact) {
          result.errors.push('Sin contactos disponibles para esta línea — agregar contactos al pool')
          console.warn(`[warmup/process] ${line.instance_name}: sin contactos disponibles`)
          break
        }

        // 5b. Mensaje con rotación Redis (Fix 2) ──────────────────────────
        const phase          = getWarmupPhase(line.current_day)
        const recentMessages = await getRecentMessages(line.id)
        const msgData        = getNextWarmupMessage(line.id, phase, recentMessages)

        // 5c. Enviar via Evolution API ─────────────────────────────────────
        let sendOk       = false
        let httpStatus   = 0
        let responseBody = ''

        try {
          const evoRes = await fetch(
            `${evoUrl}/message/sendText/${line.instance_name}`,
            {
              method:  'POST',
              headers: { 'Content-Type': 'application/json', apikey: apiKey },
              body:    JSON.stringify({ number: contact.phone_number, text: msgData.content }),
              signal:  AbortSignal.timeout(15_000),
            },
          )
          httpStatus = evoRes.status
          if (evoRes.ok) {
            sendOk = true
          } else {
            try {
              const d  = await evoRes.json()
              responseBody = JSON.stringify(d)
            } catch {
              responseBody = String(evoRes.status)
            }
          }
        } catch (fetchErr) {
          httpStatus   = 0
          responseBody = fetchErr instanceof Error ? fetchErr.message : 'fetch error'
        }

        // 5d. Clasificar error si hubo fallo (Fix 4) ──────────────────────
        const errorType: EvoErrorType | null = sendOk
          ? null
          : classifyEvoError(httpStatus, responseBody)

        const isBanned = errorType === 'permanent_ban'

        // 5e. Registrar actividad — RPC atómico (Fix 3) ───────────────────
        // warmup_record_activity() (migración 065) consolida en 1 transacción:
        //   INSERT warmup_activity_log + UPDATE warmup_numbers + UPDATE warmup_contacts
        // Antes eran 3-4 queries separadas → race condition en invocaciones paralelas.
        try {
          await query(`
            SELECT warmup_record_activity(
              $1::uuid,    -- p_warmup_number_id
              $2::uuid,    -- p_contact_id
              $3,          -- p_phone_number  (número de la línea emisora)
              $4,          -- p_recipient     (número del contacto receptor)
              $5,          -- p_message_type
              $6,          -- p_message_preview
              $7::int,     -- p_warmup_day
              $8::bool,    -- p_success
              $9::bool,    -- p_is_banned
              NULL::int,   -- p_health_score   (calculado por orchestrator/run)
              NULL::jsonb, -- p_health_components
              $10,         -- p_error_type
              $11::int     -- p_daily_quota
            )
          `, [
            line.id,
            contact.id,
            line.phone_number,        // número real de la línea (no instance_name)
            contact.phone_number,
            msgData.type,
            msgData.content.slice(0, 200),
            line.current_day,
            sendOk,
            isBanned,
            errorType,                // null si éxito, string si fallo
            effectiveLimit,           // cuota del día como daily_quota
          ])
        } catch (rpcErr) {
          // El RPC falla solo si hay un error de schema/DB grave.
          // Loggeamos pero no abortamos el batch — ya se envió el mensaje.
          console.error(
            `[warmup/process] RPC warmup_record_activity falló para ${line.instance_name}:`,
            rpcErr instanceof Error ? rpcErr.message : rpcErr,
          )
        }

        // 5f. Post-envío exitoso ───────────────────────────────────────────
        if (sendOk) {
          // Registrar en Redis para deduplicación de rotación (Fix 2)
          await recordSentMessage(line.id, msgData.content)

          result.sent++
          totalSent++
          console.info(
            `[warmup/process] ${antiBanActive ? '[anti-ban] ' : ''}${line.instance_name}: ` +
            `→ ${contact.phone_number} [${phase}] ` +
            `(día ${line.current_day}, ${line.messages_sent_today + result.sent}/${effectiveLimit})`,
          )
          continue
        }

        // 5g. Manejo de fallos ─────────────────────────────────────────────
        result.errors.push(`${errorType}: ${responseBody}`)
        console.warn(
          `[warmup/process] ${line.instance_name}: fallo [${errorType}] — ${responseBody}`,
        )

        if (isBanned) {
          // Ban permanente → el RPC ya actualizó warmup_status = 'banned'.
          // Interrumpir el batch de esta línea inmediatamente.
          console.error(
            `[warmup/process] ${line.instance_name}: BAN PERMANENTE detectado → marcada como banned`,
          )
          break
        }

        // Cualquier otro error: registramos y seguimos con el siguiente mensaje del batch.
        // El circuit breaker actuará en el próximo tick si los fallos persisten.
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

  } catch (err) {
    console.error('[warmup/process POST]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
