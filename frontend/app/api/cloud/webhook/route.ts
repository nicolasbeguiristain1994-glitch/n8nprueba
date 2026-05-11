import { NextRequest, NextResponse }  from 'next/server'
import { verifyWebhookSignature, verifyWebhookChallenge } from '@/lib/cloud-api/webhook-verifier'
import { handleInboundMessage }       from '@/lib/cloud-api/webhook-handlers/inbound-message.handler'
import { handleDeliveryStatus }       from '@/lib/cloud-api/webhook-handlers/delivery-status.handler'
import { handleEchoMessage }          from '@/lib/cloud-api/webhook-handlers/echo-message.handler'
import { handleTemplateStatusUpdate } from '@/lib/cloud-api/webhook-handlers/template-status.handler'
import { handleCoexistenceSyncEvent } from '@/lib/cloud-api/webhook-handlers/coexistence-sync.handler'
import { createCorrelationId }        from '@/lib/cloud-api/correlation'
import { createLogger }               from '@/lib/cloud-api/infrastructure/logger'
import type { WebhookPayload, WebhookTemplateStatusUpdate, WebhookSyncEvent } from '@/lib/cloud-api/types/webhooks'
import type { SmbSyncType } from '@/lib/cloud-api/types/domain'

// ─── GET: Verificación del endpoint ──────────────────────────────────────────

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const challenge = verifyWebhookChallenge({
    mode:        p.get('hub.mode'),
    token:       p.get('hub.verify_token'),
    challenge:   p.get('hub.challenge'),
    verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN!,
  })
  if (!challenge) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return new NextResponse(challenge, { status: 200 })
}

// ─── POST: Recepción de eventos de Meta ───────────────────────────────────────
// Meta exige responder en < 3 segundos. Procesamos async y respondemos inmediatamente.

export async function POST(req: NextRequest) {
  const appSecret = process.env.META_APP_SECRET
  if (!appSecret) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })

  const rawBody = Buffer.from(await req.arrayBuffer())
  const verify  = verifyWebhookSignature(rawBody, Object.fromEntries(req.headers.entries()), appSecret)

  if (!verify.valid) {
    const log = createLogger({ correlationId: createCorrelationId(), operation: 'webhook_post' })
    log.logWarn('signature rejected', { reason: verify.reason })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: WebhookPayload
  try {
    payload = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (payload.object !== 'whatsapp_business_account') {
    return NextResponse.json({ error: 'Unexpected object' }, { status: 400 })
  }

  const correlationId = createCorrelationId()
  const log           = createLogger({ correlationId, operation: 'webhook_dispatch' })
  log.logInfo('received', { entries: payload.entry.length })

  dispatch(payload, correlationId, log).catch(err =>
    log.logError('dispatch error', err),
  )

  return NextResponse.json({ ok: true })
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function dispatch(
  payload:       WebhookPayload,
  correlationId: string,
  log:           ReturnType<typeof createLogger>,
): Promise<void> {
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const phoneNumberId = change.value.metadata.phone_number_id

      try {
        switch (change.field) {

          case 'messages':
            for (const msg of change.value.messages ?? []) {
              await handleInboundMessage(phoneNumberId, msg, change.value.contacts ?? [], correlationId)
            }
            for (const status of change.value.statuses ?? []) {
              await handleDeliveryStatus(phoneNumberId, status, correlationId)
            }
            break

          case 'smb_message_echoes':
            for (const msg of change.value.messages ?? []) {
              await handleEchoMessage(phoneNumberId, msg, correlationId)
            }
            break

          case 'smb_app_state_sync':
            await handleCoexistenceSyncEvent(
              phoneNumberId, 'smb_app_state_sync' as SmbSyncType,
              change.value as unknown as WebhookSyncEvent, correlationId,
            )
            break

          case 'history':
            await handleCoexistenceSyncEvent(
              phoneNumberId, 'history' as SmbSyncType,
              change.value as unknown as WebhookSyncEvent, correlationId,
            )
            break

          case 'message_template_status_update':
            await handleTemplateStatusUpdate(
              change.value as unknown as WebhookTemplateStatusUpdate, correlationId,
            )
            break

          default:
            log.logInfo('unhandled field', { field: change.field, phoneNumberId })
        }
      } catch (err) {
        log.logError('handler error', err, { field: change.field, phoneNumberId })
      }
    }
  }
}
