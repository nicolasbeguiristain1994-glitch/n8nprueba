import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { MetaCloudApiClient } from '@/lib/cloud-api/client'
import { getTokenForNumber } from '@/lib/cloud-api/token-store'
import { assertNotOptedOut, logSendAttempt } from '@/lib/cloud-api/compliance'
import { getConversationWindow } from '@/lib/cloud-api/conversation-window'
import { enforceRateLimit } from '@/lib/cloud-api/rate-limiter'
import { enqueueMessage } from '@/lib/cloud-api/message-queue'
import { query } from '@/lib/db'
import { audit } from '@/lib/audit'
import type { SendMessageRequest } from '@/lib/cloud-api/types'
import {
  ConversationWindowError,
  OptOutError,
  RateLimitError,
  CloudApiError,
} from '@/lib/cloud-api/errors'
import { randomUUID } from 'crypto'

// POST /api/cloud/messages
// Envía un mensaje via WhatsApp Cloud API.
// Verifica opt-out, ventana de servicio, rate limit y encola si es necesario.

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'send', 'create')
  if (!auth.ok) return auth.response

  let body: Partial<SendMessageRequest> & { enqueue?: boolean }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const { phoneNumberId, to, type, enqueue = false, ...rest } = body

  if (!phoneNumberId || !to || !type) {
    return NextResponse.json({ error: 'Se requieren: phoneNumberId, to, type' }, { status: 400 })
  }

  // Validar formato E.164
  if (!/^\+[1-9]\d{6,14}$/.test(to)) {
    return NextResponse.json({ error: 'El número debe estar en formato E.164 (+5491112345678)' }, { status: 400 })
  }

  // CRÍTICO: verificar opt-out antes de cualquier envío
  try {
    await assertNotOptedOut(to, phoneNumberId)
  } catch (err) {
    if (err instanceof OptOutError) {
      return NextResponse.json({ error: err.message, code: 'OPT_OUT' }, { status: 422 })
    }
    throw err
  }

  // Verificar ventana de servicio para mensajes de texto libre
  if (type !== 'template') {
    const window = await getConversationWindow(phoneNumberId, to)
    if (window.mustUseTemplate) {
      return NextResponse.json({
        error: 'No hay ventana de servicio abierta. Debes usar una plantilla aprobada de Meta.',
        code:  'WINDOW_CLOSED',
        hint:  'Envía un mensaje de tipo "template" para iniciar la conversación.',
      }, { status: 422 })
    }
  }

  const messageId = randomUUID()
  const sendReq: SendMessageRequest = {
    phoneNumberId,
    to,
    type,
    ...rest,
    sentByUserId: auth.user.user_id,
  } as SendMessageRequest

  // Modo encolado: para campañas / envíos masivos
  if (enqueue) {
    try {
      const accessToken = await getTokenForNumber(phoneNumberId)
      const client      = new MetaCloudApiClient(accessToken)

      // Crear registro en DB con estado 'queued'
      const convResult = await query<{ id: string }>(
        `INSERT INTO cloud_conversations (phone_number_id, contact_phone, status)
         VALUES ($1, $2, 'open')
         ON CONFLICT (phone_number_id, contact_phone) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        [phoneNumberId, to],
      )
      const convId = convResult[0].id

      await query(
        `INSERT INTO cloud_messages
           (id, conversation_id, phone_number_id, direction, message_type, content,
            status, queued_at, campaign_id, sent_by_user_id)
         VALUES ($1, $2, $3, 'outbound', $4, $5, 'queued', NOW(), $6, $7)`,
        [messageId, convId, phoneNumberId, type, JSON.stringify(body), body.campaignId ?? null, auth.user.user_id],
      )

      const jobId = await enqueueMessage({
        jobId:         messageId,
        messageId,
        phoneNumberId,
        to,
        payload:       client['buildMessagePayload'](sendReq),
        attempts:      0,
        campaignId:    body.campaignId,
      })

      return NextResponse.json({ messageId, jobId, status: 'queued' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  // Modo inmediato: envío directo con rate limit
  try {
    await enforceRateLimit(phoneNumberId)

    const accessToken = await getTokenForNumber(phoneNumberId)
    const client      = new MetaCloudApiClient(accessToken)
    const { wamid }   = await client.sendMessage(sendReq)

    // Persistir mensaje enviado
    const convResult = await query<{ id: string }>(
      `INSERT INTO cloud_conversations (phone_number_id, contact_phone, status, last_message_at)
       VALUES ($1, $2, 'open', NOW())
       ON CONFLICT (phone_number_id, contact_phone) DO UPDATE
         SET last_message_at = NOW(), updated_at = NOW()
       RETURNING id`,
      [phoneNumberId, to],
    )
    const convId = convResult[0].id

    await query(
      `INSERT INTO cloud_messages
         (id, conversation_id, phone_number_id, wamid, direction, message_type,
          content, status, sent_at, template_name, campaign_id, sent_by_user_id)
       VALUES ($1, $2, $3, $4, 'outbound', $5, $6, 'sent', NOW(), $7, $8, $9)`,
      [
        messageId, convId, phoneNumberId, wamid, type,
        JSON.stringify(body),
        type === 'template' ? body.template?.name : null,
        body.campaignId ?? null,
        auth.user.user_id,
      ],
    )

    await logSendAttempt({
      phoneNumberId,
      to,
      messageId,
      messageType:  type,
      templateName: type === 'template' ? body.template?.name : undefined,
      campaignId:   body.campaignId,
      sentByUserId: auth.user.user_id,
      success:      true,
    })

    void audit({
      req,
      action:   'create',
      resource: 'send',
      metadata: { phoneNumberId, to, type, wamid, messageId },
    })

    return NextResponse.json({ messageId, wamid, status: 'sent' })

  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { error: err.message, retryAfterMs: err.retryAfterMs },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(err.retryAfterMs / 1000)) } },
      )
    }

    if (err instanceof ConversationWindowError) {
      return NextResponse.json({ error: err.message, code: 'WINDOW_CLOSED' }, { status: 422 })
    }

    if (err instanceof CloudApiError) {
      await logSendAttempt({
        phoneNumberId, to, messageId, messageType: type, success: false,
        errorCode: err.code, errorMessage: err.message,
      })
      return NextResponse.json({ error: err.message, code: err.code }, { status: 500 })
    }

    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
