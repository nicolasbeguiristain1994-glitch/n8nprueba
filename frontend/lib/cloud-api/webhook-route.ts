import { query } from '@/lib/db'
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
import { cloudNumberRepository } from '@/lib/cloud-api/repositories/cloud-number.repository'
import { metaApp, type MetaAppConfig } from './app-config'

function resolveApp(appId?: string): MetaAppConfig | NextResponse {
  try {
    const app = metaApp(appId)
    // The existing app keeps its original callback URL.
    if (!app || (appId !== undefined && app.legacy)) return NextResponse.json({ error: 'Unknown app' }, { status: 404 })
    return app
  } catch {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 503 })
  }
}

// ─── GET: Verificación del endpoint ──────────────────────────────────────────

export async function handleWebhookGet(req: NextRequest, appId?: string) {
  const app = resolveApp(appId)
  if (app instanceof NextResponse) return app
  const p = req.nextUrl.searchParams
  const challenge = verifyWebhookChallenge({
    mode:        p.get('hub.mode'),
    token:       p.get('hub.verify_token'),
    challenge:   p.get('hub.challenge'),
    verifyToken: app.verifyToken,
  })
  if (!challenge) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return new NextResponse(challenge, { status: 200 })
}

// ─── POST: Recepción de eventos de Meta ───────────────────────────────────────
// Acknowledge only after processing. A failed handler returns 503 so Meta retries.

export async function handleWebhookPost(req: NextRequest, appId?: string) {
  const app = resolveApp(appId)
  if (app instanceof NextResponse) return app
  const appSecret = app.appSecret
  if (!appSecret) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })

  const rawBody = Buffer.from(await req.arrayBuffer())
  if (rawBody.length > 5 * 1024 * 1024) return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
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

  if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)
    || payload.entry.some(entry => !entry || typeof entry.id !== 'string' || !Array.isArray(entry.changes)
      || entry.changes.some(change => !change || typeof change.field !== 'string' || !change.value || typeof change.value !== 'object'))) {
    return NextResponse.json({ error: 'Unexpected object' }, { status: 400 })
  }

  // Validate the whole batch before any side effect, including template events
  // without phone metadata. A valid signature alone does not authorize a WABA.
  if (payload.entry.some(entry => !app.permitsWaba(entry.id))) {
    return NextResponse.json({ error: 'WABA not assigned to app' }, { status: 403 })
  }

  const correlationId = createCorrelationId()
  const log           = createLogger({ correlationId, operation: 'webhook_dispatch' })
  log.logInfo('received', { entries: payload.entry.length })

  try { await dispatch(payload, correlationId, log, app) }
  catch {
    log.logWarn('dispatch incomplete; provider must retry')
    return NextResponse.json({ error: 'Temporary processing failure' }, { status: 503 })
  }

  return NextResponse.json({ ok: true })
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function dispatch(
  payload:       WebhookPayload,
  correlationId: string,
  log:           ReturnType<typeof createLogger>,
  app:           MetaAppConfig,
): Promise<void> {
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      // Template updates have no phone metadata.
      const phoneNumberId = change.field === 'message_template_status_update' ? undefined : change.value.metadata?.phone_number_id

      try {
        if (change.field === 'message_template_status_update') {
          await handleTemplateStatusUpdate(
            change.value as unknown as WebhookTemplateStatusUpdate, correlationId,
            { wabaId: entry.id, includeLegacy: app.legacy },
          )
          continue
        }
        if (!phoneNumberId) continue
        const number = await cloudNumberRepository.findByPhoneNumberId(phoneNumberId)
        if (!number || number.wabaId !== entry.id) continue
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
            for (const msg of (change.value as unknown as { message_echoes?: import('@/lib/cloud-api/types/webhooks').WebhookMessage[] }).message_echoes ?? change.value.messages ?? []) {
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

          default:
            log.logInfo('unhandled field', { field: change.field, phoneNumberId })
        }
        if (phoneNumberId) await query(`INSERT INTO cloud_sync_state(phone_number_id,last_webhook_at) VALUES ($1,NOW()) ON CONFLICT(phone_number_id) DO UPDATE SET last_webhook_at=NOW(),updated_at=NOW()`, [phoneNumberId])
      } catch (err) {
        log.logWarn('handler failed', { field: change.field, phoneNumberId })
        throw err
      }
    }
  }
}
