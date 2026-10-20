import { recordHumanAutomationIntervention } from '@/lib/automation-safety'
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { query } from '@/lib/db'
import { recordGlobalOptOut } from '@/lib/global-opt-out'
import { complianceRepository } from '@/lib/cloud-api/repositories/compliance.repository'
import { evolutionOptOutCandidates } from '@/lib/opt-out-command'
import { sendOptOutConfirmation } from '@/lib/opt-out-confirmation'
import { evaluateAutomations } from '@/lib/automation-engine'
import { notify } from '@/lib/notify'
import { parseInstancesResponse } from '@/lib/evolution-utils'
import { sseEmitter } from '@/lib/sse-events'
import { receiveEvolutionReaction } from '@/lib/evolution-reactions'

// ── syncLinePhoneNumber ───────────────────────────────────────────────────────
// Best-effort: fetch phone from Evolution and persist to DB when a line connects.
// Called fire-and-forget (void) — errors are logged, never thrown.
async function syncLinePhoneNumber(instanceName: string): Promise<void> {
  try {
    const apiKey = process.env.EVOLUTION_GLOBAL_API_KEY || process.env.EVOLUTION_API_KEY
    const evoUrl = process.env.EVOLUTION_URL || ''
    if (!apiKey || !evoUrl) return

    const res  = await fetch(
      `${evoUrl}/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`,
      { headers: { apikey: apiKey } },
    )
    const body = await res.json().catch(() => null)
    const { phone_number } = parseInstancesResponse(res.status, body)
    if (!phone_number) return

    await query(
      `UPDATE whatsapp_lines
       SET phone_number = $1, updated_at = NOW()
       WHERE evolution_instance = $2
         AND phone_number IS DISTINCT FROM $1`,
      [phone_number, instanceName],
    )
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'line.phone_synced', instance: instanceName, phone_number }))
  } catch (e) {
    console.error('[webhook/evolution] syncLinePhoneNumber failed:', instanceName, e instanceof Error ? e.message : e)
  }
}

// Evolution API v2 webhook handler
// Handles: messages.upsert (inbound) + messages.update (status updates)

export async function POST(req: NextRequest) {
  // ── Auth: validate shared secret ─────────────────────────────────────────
  const secret = process.env.EVOLUTION_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 })
  }
  const incoming = req.headers.get('x-webhook-secret') ?? ''
  // timingSafeEqual requires equal-length buffers; compare as hex digests to avoid
  // length-leaking from variable-length UTF-8 input
  const secretBuf   = Buffer.from(secret,   'utf8')
  const incomingBuf = Buffer.from(incoming, 'utf8')
  const lengthsMatch = secretBuf.length === incomingBuf.length
  // Pad shorter buffer so timingSafeEqual never throws; lengthsMatch check rejects mismatches
  const paddedIncoming = lengthsMatch
    ? incomingBuf
    : Buffer.concat([incomingBuf, Buffer.alloc(Math.max(0, secretBuf.length - incomingBuf.length))])
  if (!lengthsMatch || !timingSafeEqual(secretBuf, paddedIncoming)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  // ── Runtime type guards ───────────────────────────────────────────────────
  if (typeof body.event !== 'string') {
    return NextResponse.json({ error: 'Missing event field' }, { status: 400 })
  }
  if (body.data === null || typeof body.data !== 'object') {
    return NextResponse.json({ error: 'Missing data field' }, { status: 400 })
  }

  const event = body.event
  const data  = body.data as Record<string, unknown>

  // ── Mensaje entrante / confirmación de envío ──────────────────────────────
  if (event === 'messages.upsert' || event === 'MESSAGES_UPSERT') {
    // Validate key shape
    if (typeof data.key !== 'object' || data.key === null) {
      return NextResponse.json({ error: 'Missing key in data' }, { status: 400 })
    }
    const key     = data.key as Record<string, unknown>
    const fromMe  = key.fromMe as boolean
    const jid     = typeof key.remoteJid === 'string' ? key.remoteJid : ''
    const msgId   = typeof key.id === 'string' ? key.id : ''

    // Ignorar grupos
    if (jid.endsWith('@g.us')) return NextResponse.json({ ok: true })

    const phone = jid.replace('@s.whatsapp.net', '')

    try {
      const reaction = (data.message as Record<string,unknown> | null)?.reactionMessage
      if (reaction && typeof reaction === 'object') {
        await receiveEvolutionReaction({instance:body.instance,phone,eventId:msgId,fromMe,
          reaction:reaction as Record<string,unknown>,timestamp:data.messageTimestamp})
        return NextResponse.json({ok:true})
      }
      // Mensaje propio (outbound): Evolution confirmó envío — guardar el ID para tracking
      if (fromMe) {
        const sourceId=typeof body.instance==='string'?body.instance:''
        const outgoing=data.message as Record<string,unknown>|null
        const text=typeof outgoing?.conversation==='string'?outgoing.conversation:
          (outgoing?.extendedTextMessage as {text?:string}|undefined)?.text
        // API echoes can precede the HTTP response. Only a matching pending
        // API message on this exact line is evidence that this is not a human.
        const known=msgId?await query(`SELECT 1 FROM whatsapp_messages w WHERE w.direction='outbound' AND
          (w.evolution_message_id=$1 OR (w.evolution_message_id IS NULL AND w.status='queued'
            AND regexp_replace(w.phone_number,'[^0-9]','','g')=$2 AND w.message_body=$3
            AND w.created_at>NOW()-interval '30 seconds' AND (
              w.metadata->>'line_id' IN(SELECT id::text FROM whatsapp_lines WHERE evolution_instance=$4)
              OR EXISTS(SELECT 1 FROM campaign_recipients r JOIN whatsapp_lines l ON l.id=r.line_id
                WHERE r.id=w.campaign_recipient_id AND l.evolution_instance=$4)))) LIMIT 1`,
          [msgId,phone.replace(/\D/g,''),text??null,sourceId]):[]
        if(sourceId && !known.length) await recordHumanAutomationIntervention(phone,{provider:'evolution',sourceId},
          new Date(Number(data.messageTimestamp)*1000))
        if (msgId) {
          await query(
            `UPDATE whatsapp_messages
             SET evolution_message_id = $1, updated_at = NOW()
             WHERE id = (
               SELECT id FROM whatsapp_messages
               WHERE phone_number = $2
                 AND direction    = 'outbound'
                 AND evolution_message_id IS NULL
                 AND created_at  > NOW() - INTERVAL '10 minutes'
               ORDER BY created_at DESC
               LIMIT 1
             )`,
            [msgId, phone]
          )
        }
        return NextResponse.json({ ok: true })
      }

      // Extraer texto del mensaje (distintos tipos)
      const msg = data.message as Record<string, unknown> | null
      const body_text =
        (msg?.conversation as string) ||
        (msg?.extendedTextMessage as Record<string,unknown>)?.text as string ||
        (msg?.imageMessage as Record<string,unknown>)?.caption as string ||
        (msg?.videoMessage as Record<string,unknown>)?.caption as string ||
        '[media]'

      const ts = data.messageTimestamp as number
      const sent_at = ts ? new Date(ts * 1000).toISOString() : new Date().toISOString()

      // Idempotent insert — unique index on evolution_message_id handles dedup
      await query(
        `INSERT INTO whatsapp_messages
           (phone_number, message_body, direction, status, evolution_message_id, created_at,metadata)
         VALUES ($1, $2, 'inbound', 'received', $3, $4,
           COALESCE((SELECT jsonb_build_object('line_id',id) FROM whatsapp_lines WHERE evolution_instance=$5),'{}'::jsonb))
         ON CONFLICT (evolution_message_id) WHERE evolution_message_id IS NOT NULL DO NOTHING`,
        [phone, body_text, msgId || null, sent_at, typeof body.instance==='string'?body.instance:'']
      )

      // Notificar en tiempo real a todos los clientes SSE conectados
      sseEmitter.emit('update', { source: 'message', phone: phone })

      // Failures propagate so Evolution retries the consent event; never run
      // an automation or acknowledge an opt-out that was not durably applied.
      for (const command of evolutionOptOutCandidates(msg)) {
        if (await complianceRepository.matchesStopKeyword(command)) {
          const sourceId = typeof body.instance === 'string' ? body.instance : 'unknown'
          const confirmation = command.trim().toUpperCase() === 'BAJA'
          await recordGlobalOptOut({phone,sourceId,
            provider:'evolution',messageId:msgId || undefined,text:command,confirmation,
            metadata:{input_type:msg?.conversation || msg?.extendedTextMessage ? 'text' : 'button',
              context_wamid:((msg?.extendedTextMessage ?? msg?.buttonsResponseMessage ?? msg?.templateButtonReplyMessage) as {contextInfo?:{stanzaId?:string}})?.contextInfo?.stanzaId}})
          if (confirmation && msgId) await sendOptOutConfirmation({phone,sourceId,messageId:msgId,provider:'evolution'})
          sseEmitter.emit('update', {source:'message',phone})
          return NextResponse.json({ok:true})
        }
      }

      // ── Notificación al operador asignado a la conversación ──────────────────
      // Si la conversación está escalada y tiene un agente asignado (support_agents),
      // buscamos el usuario equivalente en `users` por email y le notificamos.
      if (typeof body_text === 'string' && body_text !== '[media]') {
        try {
          const assignedUsers = await query<{ user_id: string; name: string | null }>(
            `SELECT u.id AS user_id, u.name
             FROM conversation_state cs
             JOIN support_agents sa ON sa.id = cs.assigned_agent_id
             JOIN users u ON u.email = sa.email
             WHERE cs.phone_number = $1
               AND cs.resolved_at IS NULL
               AND cs.is_escalated = TRUE
             LIMIT 1`,
            [phone]
          )
          if (assignedUsers.length > 0) {
            void notify({
              userId:      assignedUsers[0].user_id,
              type:        'mensaje_nuevo',
              title:       `Nuevo mensaje de ${phone}`,
              body:        body_text.length > 100 ? body_text.slice(0, 97) + '…' : body_text,
              link:        '/conversations',
              relatedType: 'conversation',
              relatedId:   phone,
            })
          }
        } catch {
          // No bloquear el flujo principal si falla la notificación
        }
      }

      // ── Evaluación de automatizaciones (fire-and-forget) ─────────────────────
      // Solo si el mensaje no es un opt-out (ya fue manejado arriba).
      // El engine nunca lanza excepciones — los errores son capturados internamente.
      if (typeof body_text === 'string') {
        const insertedMsg = await query<{ id: string }>(
          `SELECT id FROM whatsapp_messages
           WHERE evolution_message_id = $1
           LIMIT 1`,
          [msgId || null],
        ).catch(() => [] as { id: string }[])

        const messageId = insertedMsg[0]?.id ?? null

        // Fire-and-forget: no bloquea la respuesta al webhook
        await evaluateAutomations(phone, body_text, messageId, { provider: 'evolution', instance: typeof body.instance === 'string' ? body.instance : '', receivedAt:sent_at })
      }

      return NextResponse.json({ ok: true })
    } catch (e) {
      console.error('[webhook/evolution] messages.upsert error:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  // ── Actualización de estado (enviado → entregado → leído) ─────────────────
  if (event === 'messages.update' || event === 'MESSAGES_UPDATE') {
    const updates = Array.isArray(data) ? data : [data]

    try {
      for (const upd of updates) {
        if (typeof upd !== 'object' || upd === null) continue
        const u = upd as Record<string, unknown>

        // Validate key and update objects
        if (typeof u.key !== 'object' || u.key === null) continue
        if (typeof u.update !== 'object' || u.update === null) continue

        const key    = u.key as Record<string, unknown>
        const msgId  = typeof key.id === 'string' ? key.id : ''
        const jid    = typeof key.remoteJid === 'string' ? key.remoteJid : ''
        const raw    = (u.update as Record<string, unknown>).status

        if (!msgId || raw === undefined) continue

        const phone = jid.replace('@s.whatsapp.net', '')

        // Evolution puede enviar número (0-5) o string
        let status = 'sent'
        const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10)
        if (!isNaN(n)) {
          if (n >= 4) status = 'read'
          else if (n === 3) status = 'delivered'
          else if (n === 2) status = 'sent'
        } else {
          const s = String(raw).toUpperCase()
          if (s === 'READ' || s === 'PLAYED') status = 'read'
          else if (s === 'DELIVERY_ACK' || s === 'DELIVERED') status = 'delivered'
          else if (s === 'SERVER_ACK' || s === 'SENT') status = 'sent'
          else if (s === 'FAILED' || s === 'ERROR') status = 'failed'
        }

        // Intentar actualizar por evolution_message_id exacto primero
        // $1::message_status cast needed — PostgreSQL can't infer consistent type when $1
        // appears both in SET status=$1 and in CASE WHEN $1='delivered' comparisons.
        const res1 = await query<{ id: string }>(
          `UPDATE whatsapp_messages
           SET status       = $1::message_status,
               evolution_message_id = COALESCE(evolution_message_id, $2),
               delivered_at = CASE WHEN $1::message_status = 'delivered' THEN NOW() ELSE delivered_at END,
               read_at      = CASE WHEN $1::message_status = 'read'      THEN NOW() ELSE read_at END,
               failed_at    = CASE WHEN $1::message_status = 'failed'    THEN NOW() ELSE failed_at END,
               updated_at   = NOW()
           WHERE evolution_message_id = $2
           RETURNING id`,
          [status, msgId]
        )

        // Fallback: si no hubo match por ID, buscar por teléfono
        if (res1.length === 0 && phone) {
          await query(
            `UPDATE whatsapp_messages
             SET status       = $1::message_status,
                 evolution_message_id = $2,
                 delivered_at = CASE WHEN $1::message_status = 'delivered' THEN NOW() ELSE delivered_at END,
                 read_at      = CASE WHEN $1::message_status = 'read'      THEN NOW() ELSE read_at END,
                 failed_at    = CASE WHEN $1::message_status = 'failed'    THEN NOW() ELSE failed_at END,
                 updated_at   = NOW()
             WHERE id = (
               SELECT id FROM whatsapp_messages
               WHERE phone_number = $3
                 AND direction    = 'outbound'
                 AND status NOT IN ('read', 'failed')
                 AND sent_at > NOW() - INTERVAL '24 hours'
               ORDER BY sent_at DESC
               LIMIT 1
             )`,
            [status, msgId, phone]
          )
        }
      }

      return NextResponse.json({ ok: true })
    } catch (e) {
      console.error('[webhook/evolution] messages.update error:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  // ── Cambio de estado de conexión ─────────────────────────────────────────
  // Evolution emite CONNECTION_UPDATE cuando una instancia se conecta o
  // desconecta. Usamos esto para mantener is_connected sincronizado en DB
  // sin depender solo del polling del modal QR.
  if (event === 'connection.update' || event === 'CONNECTION_UPDATE') {
    try {
      const instanceName = typeof body.instance === 'string' ? body.instance : null
      const state        = typeof data.state    === 'string' ? data.state    : null

      if (instanceName && state) {
        if (state === 'open') {
          await query(
            `UPDATE whatsapp_lines
             SET is_connected = true, status = 'active', last_seen_at = NOW(), updated_at = NOW()
             WHERE evolution_instance = $1`,
            [instanceName],
          ).catch(e => console.error('[webhook/evolution] CONNECTION_UPDATE open db update failed:', e?.message))
          console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'line.connected', instance: instanceName }))
          void syncLinePhoneNumber(instanceName)
          // Ensure readStatus=true on every reconnect so MESSAGES_UPDATE ACKs keep firing
          void (async () => {
            const evoUrl = process.env.EVOLUTION_URL || ''
            const apiKey = process.env.EVOLUTION_GLOBAL_API_KEY || process.env.EVOLUTION_API_KEY || ''
            if (!evoUrl || !apiKey) return
            await fetch(`${evoUrl}/settings/set/${encodeURIComponent(instanceName)}`, {
              method:  'POST',
              headers: { apikey: apiKey, 'Content-Type': 'application/json' },
              body:    JSON.stringify({ readStatus: true }),
              signal:  AbortSignal.timeout(5000),
            }).catch(e => console.warn('[webhook/evolution] readStatus setup failed:', e?.message))
          })()
        } else if (state === 'close') {
          await query(
            `UPDATE whatsapp_lines
             SET is_connected = false, updated_at = NOW()
             WHERE evolution_instance = $1`,
            [instanceName],
          ).catch(e => console.error('[webhook/evolution] CONNECTION_UPDATE close db update failed:', e?.message))
          console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'line.disconnected', instance: instanceName }))
        }
      }
    } catch (e) {
      console.error('[webhook/evolution] CONNECTION_UPDATE error:', e instanceof Error ? e.message : e)
    }
    return NextResponse.json({ ok: true })
  }

  // Otros eventos ignorados
  return NextResponse.json({ ok: true })
}
