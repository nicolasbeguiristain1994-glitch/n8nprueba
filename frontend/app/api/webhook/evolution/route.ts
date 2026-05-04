import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { query } from '@/lib/db'
import { normalizePhone } from '@/lib/validate'
import { evaluateAutomations } from '@/lib/automation-engine'
import { notify } from '@/lib/notify'

// ── Palabras clave de opt-out ─────────────────────────────────────────────────
// Comparación normalizada: sin acentos, minúsculas, trim.
// Se agrega automáticamente el número a la blacklist si coincide.
const OPT_OUT_KEYWORDS = new Set([
  'baja', 'stop', 'no', 'no quiero', 'cancelar', 'no me escribas',
  'remover', 'salir', 'detener', 'borrar', 'desuscribir', 'unsub',
  'unsubscribe', 'remove', 'leave', 'quit', 'out',
])

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // eliminar acentos
    .replace(/[^a-z0-9 ]/g, '')     // solo letras, números y espacios
    .trim()
}

function isOptOut(text: string): boolean {
  const normalized = normalizeText(text)
  return OPT_OUT_KEYWORDS.has(normalized)
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
  if (event === 'messages.upsert') {
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
      // Mensaje propio (outbound): Evolution confirmó envío — guardar el ID para tracking
      if (fromMe) {
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
           (phone_number, message_body, direction, status, evolution_message_id, created_at)
         VALUES ($1, $2, 'inbound', 'received', $3, $4)
         ON CONFLICT (evolution_message_id) WHERE evolution_message_id IS NOT NULL DO NOTHING`,
        [phone, body_text, msgId || null, sent_at]
      )

      // ── Detección de opt-out automático ──────────────────────────────────────
      // Si el mensaje contiene una keyword de baja, agrega el número a blacklist.
      if (typeof body_text === 'string' && isOptOut(body_text)) {
        const normalized = normalizePhone(phone)
        if (normalized) {
          try {
            // Solo insertar si no existe ya un registro activo
            const existing = await query<{ id: string }>(
              `SELECT id FROM blacklist WHERE phone_number_normalized = $1 AND removed_at IS NULL`,
              [normalized],
            )
            if (existing.length === 0) {
              await query(
                `INSERT INTO blacklist
                   (phone_number_raw, phone_number_normalized, reason, source, original_message)
                 VALUES ($1, $2, $3, 'automatic', $4)
                 ON CONFLICT (phone_number_normalized) WHERE removed_at IS NULL DO NOTHING`,
                [
                  phone,
                  normalized,
                  `Opt-out automático: "${body_text.slice(0, 200)}"`,
                  body_text.slice(0, 500),
                ],
              )
              console.log(`[webhook/evolution] opt-out detectado: ${phone} → blacklisted`)
            }
          } catch (blErr) {
            // No bloquear el flujo si falla el blacklisting
            console.error('[webhook/evolution] error al blacklistear opt-out:', blErr instanceof Error ? blErr.message : blErr)
          }
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
      if (typeof body_text === 'string' && !isOptOut(body_text)) {
        const insertedMsg = await query<{ id: string }>(
          `SELECT id FROM whatsapp_messages
           WHERE evolution_message_id = $1
           LIMIT 1`,
          [msgId || null],
        ).catch(() => [] as { id: string }[])

        const messageId = insertedMsg[0]?.id ?? null

        // Fire-and-forget: no bloquea la respuesta al webhook
        void evaluateAutomations(phone, body_text, messageId)
      }

      return NextResponse.json({ ok: true })
    } catch (e) {
      console.error('[webhook/evolution] messages.upsert error:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  // ── Actualización de estado (enviado → entregado → leído) ─────────────────
  if (event === 'messages.update') {
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
          if (s === 'READ') status = 'read'
          else if (s === 'DELIVERED') status = 'delivered'
          else if (s === 'SENT') status = 'sent'
          else if (s === 'FAILED' || s === 'ERROR') status = 'failed'
        }

        // Intentar actualizar por evolution_message_id exacto primero
        const res1 = await query<{ id: string }>(
          `UPDATE whatsapp_messages
           SET status       = $1,
               evolution_message_id = COALESCE(evolution_message_id, $2),
               delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END,
               read_at      = CASE WHEN $1 = 'read'      THEN NOW() ELSE read_at END,
               failed_at    = CASE WHEN $1 = 'failed'    THEN NOW() ELSE failed_at END,
               updated_at   = NOW()
           WHERE evolution_message_id = $2
           RETURNING id`,
          [status, msgId]
        )

        // Fallback: si no hubo match por ID, buscar por teléfono
        if (res1.length === 0 && phone) {
          await query(
            `UPDATE whatsapp_messages
             SET status       = $1,
                 evolution_message_id = $2,
                 delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END,
                 read_at      = CASE WHEN $1 = 'read'      THEN NOW() ELSE read_at END,
                 failed_at    = CASE WHEN $1 = 'failed'    THEN NOW() ELSE failed_at END,
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

  // Otros eventos ignorados
  return NextResponse.json({ ok: true })
}
