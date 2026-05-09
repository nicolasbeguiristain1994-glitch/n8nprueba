import { NextRequest, NextResponse } from 'next/server'
import { verifyWebhookSignature, verifyWebhookChallenge } from '@/lib/cloud-api/webhook-verifier'
import { checkAndHandleStopKeyword, recordOptOut } from '@/lib/cloud-api/compliance'
import { openServiceWindow, closeServiceWindow } from '@/lib/cloud-api/conversation-window'
import { handleSyncWebhook } from '@/lib/cloud-api/coexistence-sync'
import { query } from '@/lib/db'
import type {
  WebhookPayload,
  WebhookValue,
  WebhookMessage,
  WebhookStatus,
} from '@/lib/cloud-api/types'

// ─── GET: Verificación del endpoint de webhooks por parte de Meta ─────────────

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams
  const challenge = verifyWebhookChallenge({
    mode:        params.get('hub.mode'),
    token:       params.get('hub.verify_token'),
    challenge:   params.get('hub.challenge'),
    verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN!,
  })

  if (!challenge) {
    console.warn('[cloud/webhook] Challenge verification failed')
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return new NextResponse(challenge, { status: 200 })
}

// ─── POST: Recepción de eventos de Meta ──────────────────────────────────────

export async function POST(req: NextRequest) {
  const appSecret = process.env.META_APP_SECRET!
  if (!appSecret) {
    console.error('[cloud/webhook] META_APP_SECRET not configured')
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  // Leer el body raw para verificar firma HMAC
  const rawBody = Buffer.from(await req.arrayBuffer())

  const verification = verifyWebhookSignature(
    rawBody,
    Object.fromEntries(req.headers.entries()),
    appSecret,
  )

  if (!verification.valid) {
    console.warn('[cloud/webhook] Signature verification failed:', verification.reason)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: WebhookPayload
  try {
    payload = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (payload.object !== 'whatsapp_business_account') {
    return NextResponse.json({ error: 'Unexpected object type' }, { status: 400 })
  }

  // Procesar cada entry/change de forma asíncrona (Meta espera 200 en <3s)
  // No await: procesamos en background y respondemos inmediatamente
  processWebhookAsync(payload).catch(err =>
    console.error('[cloud/webhook] Processing error:', err)
  )

  return NextResponse.json({ success: true }, { status: 200 })
}

// ─── Procesamiento asíncrono del webhook ──────────────────────────────────────

async function processWebhookAsync(payload: WebhookPayload): Promise<void> {
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const phoneNumberId = change.value.metadata.phone_number_id

      switch (change.field) {
        case 'messages':
          await processMessagesChange(phoneNumberId, change.value)
          break

        case 'smb_app_state_sync':
          await handleSyncWebhook(phoneNumberId, 'smb_app_state_sync', 'completed')
          break

        case 'history': {
          const histValue = change.value as unknown as { event?: string; error?: string }
          const histStatus = histValue.event === 'error' ? 'failed' : 'completed'
          await handleSyncWebhook(phoneNumberId, 'history', histStatus, histValue.error)
          break
        }

        case 'smb_message_echoes':
          // Mensajes enviados desde la WA Business App del cliente
          await processEchoMessages(phoneNumberId, change.value)
          break

        case 'message_template_status_update':
          await processTemplateStatusUpdate(change.value)
          break

        default:
          console.log('[cloud/webhook] Unhandled field:', change.field)
      }
    }
  }
}

// ─── Procesar mensajes entrantes y estados de envío ───────────────────────────

async function processMessagesChange(phoneNumberId: string, value: WebhookValue): Promise<void> {
  if (value.messages) {
    for (const msg of value.messages) {
      await processInboundMessage(phoneNumberId, msg, value)
    }
  }

  if (value.statuses) {
    for (const status of value.statuses) {
      await processDeliveryStatus(phoneNumberId, status)
    }
  }
}

async function processInboundMessage(
  phoneNumberId: string,
  msg:           WebhookMessage,
  value:         WebhookValue,
): Promise<void> {
  const contactPhone = `+${msg.from}`
  const profileName  = value.contacts?.find(c => c.wa_id === msg.from)?.profile.name ?? null

  // 1. Abrir/renovar ventana de servicio de 24h
  await openServiceWindow(phoneNumberId, contactPhone, 'customer_initiated')

  // 2. Detectar keywords de opt-out
  if (msg.type === 'text' && msg.text?.body) {
    const isStop = await checkAndHandleStopKeyword(
      msg.text.body,
      contactPhone,
      phoneNumberId,
      msg.id,
    )

    if (isStop) {
      // Registrar en DB y no procesar más este mensaje
      await logInboundMessage(phoneNumberId, contactPhone, msg, 'opt_out_stop')
      return
    }
  }

  // 3. Upsert contacto si existe en nuestra tabla de contacts
  if (profileName) {
    await query(
      `UPDATE contacts SET whatsapp_name = $1, updated_at = NOW() WHERE phone = $2`,
      [profileName, contactPhone],
    ).catch(() => {})
  }

  // 4. Actualizar conversación
  await upsertConversation(phoneNumberId, contactPhone, msg)

  // 5. Persistir mensaje
  await logInboundMessage(phoneNumberId, contactPhone, msg, 'received')

  // 6. Marcar como leído (best-effort)
  markAsReadAsync(phoneNumberId, msg.id)
}

async function processDeliveryStatus(phoneNumberId: string, status: WebhookStatus): Promise<void> {
  await query(
    `UPDATE cloud_messages
     SET status          = $1,
         delivered_at    = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END,
         read_at         = CASE WHEN $1 = 'read'      THEN NOW() ELSE read_at      END,
         failed_at       = CASE WHEN $1 = 'failed'    THEN NOW() ELSE failed_at    END,
         error_code      = $2,
         error_title     = $3,
         pricing_model   = $4,
         pricing_category = $5,
         billable        = $6
     WHERE wamid = $7`,
    [
      status.status,
      status.errors?.[0]?.code     ?? null,
      status.errors?.[0]?.title    ?? null,
      status.pricing?.pricing_model   ?? null,
      status.pricing?.category        ?? null,
      status.pricing?.billable        ?? null,
      status.id,
    ],
  ).catch(err => console.warn('[cloud/webhook] Failed to update delivery status:', err))

  // Si el mensaje falló por opt-out de Meta (código 131026), registrar
  if (status.status === 'failed' && status.errors?.some(e => e.code === 131026)) {
    const msgResult = await query<{ phone_number_id: string }>(
      `SELECT phone_number_id FROM cloud_messages WHERE wamid = $1`,
      [status.id],
    ).catch(() => [] as { phone_number_id: string }[])

    if (msgResult[0]) {
      await recordOptOut({
        phone:         `+${status.recipient_id}`,
        phoneNumberId: msgResult[0].phone_number_id,
        reason:        'policy_violation',
        metadata:      { wamid: status.id, errorCode: 131026 },
      }).catch(() => {})
    }
  }
}

// ─── Procesar echoes (mensajes enviados desde WA Business App) ────────────────

async function processEchoMessages(phoneNumberId: string, value: WebhookValue): Promise<void> {
  if (!value.messages) return

  for (const msg of value.messages) {
    const contactPhone = `+${msg.from}`

    // Los echoes extienden la ventana de servicio
    await openServiceWindow(phoneNumberId, contactPhone, 'customer_initiated')

    await upsertConversation(phoneNumberId, contactPhone, msg)

    // Persistir como mensaje tipo 'echo' (enviado desde WA Business App)
    await query(
      `INSERT INTO cloud_messages
         (conversation_id, phone_number_id, wamid, direction, message_type, content, status, sent_at)
       SELECT id, $1, $2, 'echo', $3, $4, 'sent', to_timestamp($5::bigint)
       FROM cloud_conversations
       WHERE phone_number_id = $1 AND contact_phone = $6
       ON CONFLICT (wamid) DO NOTHING`,
      [
        phoneNumberId,
        msg.id,
        msg.type,
        JSON.stringify(msg),
        msg.timestamp,
        contactPhone,
      ],
    ).catch(err => console.warn('[cloud/webhook] Failed to persist echo message:', err))
  }
}

// ─── Procesar actualización de estado de plantilla ───────────────────────────

async function processTemplateStatusUpdate(value: WebhookValue): Promise<void> {
  const raw = value as unknown as {
    message_template_id: string
    message_template_name: string
    message_template_language: string
    event: 'APPROVED' | 'REJECTED' | 'DISABLED' | 'PAUSED'
    reason?: string
  }

  const internalStatus = {
    APPROVED: 'APROBADA',
    REJECTED: 'RECHAZADA',
    DISABLED: 'DESHABILITADA',
    PAUSED:   'DESHABILITADA',
  }[raw.event] ?? 'EN_REVISION'

  await query(
    `UPDATE templates
     SET whatsapp_status = $1, rejection_reason = $2, updated_at = NOW()
     WHERE whatsapp_template_id = $3`,
    [internalStatus, raw.reason ?? null, raw.message_template_id],
  ).catch(err => console.warn('[cloud/webhook] Failed to update template status:', err))

  console.log('[cloud/webhook] Template status updated:', raw.message_template_name, '->', raw.event)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function upsertConversation(
  phoneNumberId: string,
  contactPhone:  string,
  msg:           WebhookMessage,
): Promise<void> {
  const preview = msg.type === 'text' ? msg.text?.body?.slice(0, 100) : `[${msg.type}]`

  await query(
    `INSERT INTO cloud_conversations
       (phone_number_id, contact_phone, last_message_at, last_message_preview,
        unread_count, status, updated_at)
     VALUES ($1, $2, to_timestamp($3::bigint), $4, 1, 'open', NOW())
     ON CONFLICT (phone_number_id, contact_phone) DO UPDATE
       SET last_message_at      = to_timestamp($3::bigint),
           last_message_preview = $4,
           unread_count         = cloud_conversations.unread_count + 1,
           status               = 'open',
           updated_at           = NOW()`,
    [phoneNumberId, contactPhone, msg.timestamp, preview],
  )
}

async function logInboundMessage(
  phoneNumberId: string,
  contactPhone:  string,
  msg:           WebhookMessage,
  _note:         string,
): Promise<void> {
  await query(
    `INSERT INTO cloud_messages
       (conversation_id, phone_number_id, wamid, direction, message_type, content, status, sent_at)
     SELECT id, $1, $2, 'inbound', $3, $4, 'delivered', to_timestamp($5::bigint)
     FROM cloud_conversations
     WHERE phone_number_id = $1 AND contact_phone = $6
     ON CONFLICT (wamid) DO NOTHING`,
    [phoneNumberId, msg.id, msg.type, JSON.stringify(msg), msg.timestamp, contactPhone],
  ).catch(err => console.warn('[cloud/webhook] Failed to log inbound message:', err))
}

function markAsReadAsync(phoneNumberId: string, wamid: string): void {
  import('@/lib/cloud-api/token-store').then(({ getTokenForNumber }) =>
    getTokenForNumber(phoneNumberId).then(token => {
      const { MetaCloudApiClient } = require('@/lib/cloud-api/client')
      new MetaCloudApiClient(token).markAsRead(phoneNumberId, wamid)
    })
  ).catch(() => {})
}
