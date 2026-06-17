/**
 * POST /api/warmup/conversations/process
 *
 * Motor de ejecución de conversaciones entre líneas.
 * Invocado cada 15 minutos por n8n, junto a /api/warmup/process.
 *
 * Flujo por conversación lista:
 *   1. get_ready_conversations() → FOR UPDATE SKIP LOCKED (concurrencia segura)
 *   2. Leer paso actual de warmup_script_steps
 *   3. Determinar sender / recipient según alias
 *   4. Verificar que ambas líneas siguen activas
 *   5. Enviar via Evolution API (sender → recipient)
 *   6. Registrar en warmup_activity_log
 *   7. Calcular delay al próximo paso (burst vs. turno)
 *   8. Actualizar warmup_conversations.current_step + next_send_at
 */

import { NextRequest, NextResponse }       from 'next/server'
import { query }                           from '@/lib/db'
import { getNextStepDelaySeconds, nextSendAt } from '@/lib/warmup-conversation-engine'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface ReadyConversation {
  conv_id:             string
  script_id:           string
  line_a_id:           string
  line_b_id:           string
  alias_a:             string
  alias_b:             string
  current_step:        number
  conv_status:         string
  next_send_at:        string | null
  messages_sent:       number
  line_a_instance:     string
  line_a_phone:        string
  line_a_status:       string
  line_a_evo_url:      string | null
  line_a_current_day:  number
  line_b_instance:     string
  line_b_phone:        string
  line_b_status:       string
  line_b_evo_url:      string | null
  line_b_current_day:  number
}

interface ScriptStep {
  step_order:    number
  speaker_alias: string
  content:       string
}

interface ConvResult {
  conv_id:  string
  outcome:  'sent' | 'completed' | 'paused' | 'failed' | 'skipped'
  reason?:  string
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {

  // Auth ligero (mismo secret que /api/warmup/process)
  const secret = process.env.WARMUP_PROCESS_SECRET
  if (secret && req.headers.get('x-warmup-secret') !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const evolutionUrl = process.env.EVOLUTION_URL
  const apiKey       = process.env.EVOLUTION_API_KEY

  if (!evolutionUrl || !apiKey) {
    return NextResponse.json(
      { error: 'EVOLUTION_URL y EVOLUTION_API_KEY son requeridos' },
      { status: 500 },
    )
  }

  const results: ConvResult[] = []

  try {
    // 1. Conversaciones listas para enviar (SKIP LOCKED para concurrencia)
    const conversations = await query<ReadyConversation>(`
      SELECT
        wc.id                  AS conv_id,
        wc.script_id,
        wc.line_a_id,
        wc.line_b_id,
        wc.alias_a             ::text,
        wc.alias_b             ::text,
        wc.current_step,
        wc.status              ::text AS conv_status,
        wc.next_send_at,
        wc.messages_sent,
        la.instance_name       ::text AS line_a_instance,
        la.phone_number        ::text AS line_a_phone,
        la.warmup_status       ::text AS line_a_status,
        la.evolution_url       ::text AS line_a_evo_url,
        la.current_day              AS line_a_current_day,
        lb.instance_name       ::text AS line_b_instance,
        lb.phone_number        ::text AS line_b_phone,
        lb.warmup_status       ::text AS line_b_status,
        lb.evolution_url       ::text AS line_b_evo_url,
        lb.current_day              AS line_b_current_day
      FROM  warmup_conversations wc
      JOIN  warmup_numbers       la ON la.id = wc.line_a_id
      JOIN  warmup_numbers       lb ON lb.id = wc.line_b_id
      WHERE wc.status IN ('pending', 'in_progress')
        AND (wc.next_send_at IS NULL OR wc.next_send_at <= NOW())
      ORDER BY wc.next_send_at ASC NULLS FIRST
      LIMIT 30
      FOR UPDATE OF wc SKIP LOCKED
    `)

    for (const conv of conversations) {

      // 2. Leer paso actual
      const [step] = await query<ScriptStep>(`
        SELECT step_order, speaker_alias, content
        FROM   warmup_script_steps
        WHERE  script_id  = $1
          AND  step_order = $2
      `, [conv.script_id, conv.current_step])

      // Paso no encontrado → conversación completada
      if (!step) {
        await query(`
          UPDATE warmup_conversations
          SET    status       = 'completed',
                 completed_at = NOW(),
                 updated_at   = NOW()
          WHERE  id = $1
        `, [conv.conv_id])
        results.push({ conv_id: conv.conv_id, outcome: 'completed' })
        continue
      }

      // 3. Determinar sender / recipient
      const isA          = step.speaker_alias === conv.alias_a
      const senderInst   = isA ? conv.line_a_instance  : conv.line_b_instance
      const senderPhone  = isA ? conv.line_a_phone      : conv.line_b_phone
      const senderStatus = isA ? conv.line_a_status     : conv.line_b_status
      const senderEvo    = isA ? conv.line_a_evo_url    : conv.line_b_evo_url
      const senderId     = isA ? conv.line_a_id         : conv.line_b_id
      const recipientPhone = isA ? conv.line_b_phone    : conv.line_a_phone

      // 4. Verificar que ambas líneas siguen activas
      if (conv.line_a_status !== 'active' || conv.line_b_status !== 'active') {
        await query(`
          UPDATE warmup_conversations
          SET    status     = 'paused',
                 updated_at = NOW()
          WHERE  id = $1
        `, [conv.conv_id])
        results.push({
          conv_id: conv.conv_id,
          outcome: 'paused',
          reason:  `línea no activa (a:${conv.line_a_status} b:${conv.line_b_status})`,
        })
        continue
      }

      // 5. Enviar via Evolution API
      const evoUrl     = senderEvo ?? evolutionUrl
      let   sendOk     = false
      let   errorBody  = ''

      try {
        const res = await fetch(
          `${evoUrl}/message/sendText/${senderInst}`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', apikey: apiKey },
            body:    JSON.stringify({ number: recipientPhone, text: step.content }),
            signal:  AbortSignal.timeout(15_000),
          },
        )

        if (res.ok) {
          sendOk = true
        } else {
          try {
            errorBody = JSON.stringify(await res.json())
          } catch {
            errorBody = String(res.status)
          }
        }
      } catch (fetchErr) {
        errorBody = fetchErr instanceof Error ? fetchErr.message : 'fetch error'
      }

      // 6. Registrar en activity_log
      await query(`
        INSERT INTO warmup_activity_log
          (warmup_number_id, phone_number, recipient, message_type, message_preview, status, warmup_day)
        VALUES ($1, $2, $3, 'conversation', $4, $5, $6)
      `, [
        senderId,
        senderPhone,
        recipientPhone,
        step.content.slice(0, 200),
        sendOk ? 'sent' : 'failed',
        isA ? conv.line_a_current_day : conv.line_b_current_day,
      ])

      if (!sendOk) {
        // No avanzamos el paso — lo reintentamos en el próximo tick
        await query(`
          UPDATE warmup_conversations
          SET    next_send_at = NOW() + interval '15 minutes',
                 updated_at   = NOW()
          WHERE  id = $1
        `, [conv.conv_id])
        results.push({ conv_id: conv.conv_id, outcome: 'failed', reason: errorBody })
        console.warn(`[conversations/process] ${senderInst} → ${recipientPhone}: fallo — ${errorBody}`)
        continue
      }

      // 7. Calcular delay al próximo paso
      const [nextStep] = await query<{ speaker_alias: string }>(`
        SELECT speaker_alias
        FROM   warmup_script_steps
        WHERE  script_id  = $1
          AND  step_order = $2
      `, [conv.script_id, conv.current_step + 1])

      const isLastStep = !nextStep

      if (isLastStep) {
        // Conversación completada
        await query(`
          UPDATE warmup_conversations
          SET    current_step  = $2,
                 status        = 'completed',
                 completed_at  = NOW(),
                 messages_sent = messages_sent + 1,
                 started_at    = COALESCE(started_at, NOW()),
                 updated_at    = NOW()
          WHERE  id = $1
        `, [conv.conv_id, conv.current_step + 1])
        results.push({ conv_id: conv.conv_id, outcome: 'completed' })
        console.info(`[conversations/process] ${conv.conv_id}: conversación completada (${conv.current_step} pasos)`)
        continue
      }

      // 8. Avanzar paso + calcular next_send_at
      const delaySeconds = getNextStepDelaySeconds(step.speaker_alias, nextStep.speaker_alias)
      const sendAt       = nextSendAt(delaySeconds)

      await query(`
        UPDATE warmup_conversations
        SET    current_step  = $2,
               status        = 'in_progress',
               next_send_at  = $3,
               messages_sent = messages_sent + 1,
               started_at    = COALESCE(started_at, NOW()),
               updated_at    = NOW()
        WHERE  id = $1
      `, [conv.conv_id, conv.current_step + 1, sendAt])

      results.push({ conv_id: conv.conv_id, outcome: 'sent' })
      console.info(
        `[conversations/process] ${senderInst} → ${recipientPhone}: ` +
        `paso ${conv.current_step} enviado. Próximo en ${delaySeconds}s`,
      )
    }

    return NextResponse.json({
      ok:        true,
      processed: conversations.length,
      results,
      timestamp: new Date().toISOString(),
    })

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[conversations/process POST]', msg)
    return NextResponse.json({ error: 'Internal server error', detail: msg }, { status: 500 })
  }
}
