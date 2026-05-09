import { query } from '@/lib/db'
import { OptOutError } from './errors'

// ─── Verificación de opt-out ──────────────────────────────────────────────────
// CRÍTICO: verificar SIEMPRE antes de enviar cualquier mensaje de marketing.
// Para mensajes de servicio (utility) iniciados por el cliente, la verificación
// sigue siendo obligatoria pero aplican excepciones (ej: respuesta a consulta activa).

export async function assertNotOptedOut(
  phone:         string,
  phoneNumberId: string,
): Promise<void> {
  const result = await query<{ opted_out: boolean }>(
    `SELECT opted_out FROM cloud_opt_outs WHERE contact_phone = $1 AND phone_number_id = $2`,
    [phone, phoneNumberId],
  )
  if (result[0]?.opted_out) throw new OptOutError(phone)
}

export async function isOptedOut(phone: string, phoneNumberId: string): Promise<boolean> {
  const result = await query<{ opted_out: boolean }>(
    `SELECT opted_out FROM cloud_opt_outs WHERE contact_phone = $1 AND phone_number_id = $2`,
    [phone, phoneNumberId],
  )
  return result[0]?.opted_out ?? false
}

// ─── Registrar opt-out ────────────────────────────────────────────────────────

export async function recordOptOut(opts: {
  phone:         string
  phoneNumberId: string
  reason:        'stop_keyword' | 'manual' | 'policy_violation' | 'user_request'
  wamid?:        string
  agentUserId?:  string
  metadata?:     Record<string, unknown>
}): Promise<void> {
  await query(
    `INSERT INTO cloud_opt_outs (contact_phone, phone_number_id, opted_out, opted_out_at, reason)
     VALUES ($1, $2, true, NOW(), $3)
     ON CONFLICT (contact_phone, phone_number_id)
     DO UPDATE SET opted_out = true, opted_out_at = NOW(), reason = $3`,
    [opts.phone, opts.phoneNumberId, opts.reason],
  )

  await query(
    `INSERT INTO cloud_consent_log
       (contact_phone, phone_number_id, event, source, message_wamid, agent_user_id, metadata)
     VALUES ($1, $2, 'opt_out', $3, $4, $5, $6)`,
    [
      opts.phone,
      opts.phoneNumberId,
      opts.wamid ? 'inbound_message' : 'agent_action',
      opts.wamid ?? null,
      opts.agentUserId ?? null,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
    ],
  )
}

// ─── Registrar opt-in ─────────────────────────────────────────────────────────

export async function recordOptIn(opts: {
  phone:         string
  phoneNumberId: string
  channel:       'whatsapp' | 'web' | 'sms' | 'manual'
  source?:       string
  agentUserId?:  string
}): Promise<void> {
  await query(
    `INSERT INTO cloud_opt_outs (contact_phone, phone_number_id, opted_out, opted_out_at, reason)
     VALUES ($1, $2, false, NULL, NULL)
     ON CONFLICT (contact_phone, phone_number_id)
     DO UPDATE SET opted_out = false, opted_out_at = NULL, reason = NULL`,
    [opts.phone, opts.phoneNumberId],
  )

  await query(
    `INSERT INTO cloud_consent_log
       (contact_phone, phone_number_id, event, channel, source, agent_user_id)
     VALUES ($1, $2, 'opt_in', $3, $4, $5)`,
    [opts.phone, opts.phoneNumberId, opts.channel, opts.source ?? null, opts.agentUserId ?? null],
  )
}

// ─── Detección automática de keywords de opt-out ────────────────────────────

export async function checkAndHandleStopKeyword(
  messageText:   string,
  phone:         string,
  phoneNumberId: string,
  wamid:         string,
): Promise<boolean> {
  const normalized = messageText.trim().toUpperCase()

  const result = await query<{ keyword: string }>(
    `SELECT keyword FROM cloud_stop_keywords WHERE upper(keyword) = $1`,
    [normalized],
  )

  if (result.length === 0) return false

  await recordOptOut({
    phone,
    phoneNumberId,
    reason: 'stop_keyword',
    wamid,
    metadata: { keyword: normalized },
  })

  console.log(`[compliance] STOP keyword "${normalized}" detected from ${phone}, opt-out recorded`)
  return true
}

// ─── Auditoría de envío ───────────────────────────────────────────────────────
// Registrar cada intento de envío para auditoría completa

export async function logSendAttempt(opts: {
  phoneNumberId:  string
  to:             string
  messageId:      string
  messageType:    string
  templateName?:  string
  campaignId?:    string
  sentByUserId?:  string
  success:        boolean
  errorCode?:     number
  errorMessage?:  string
}): Promise<void> {
  // La persistencia principal ocurre en cloud_messages via el send-processor.
  // Esta función complementa con logging estructurado para observabilidad.
  console.log(JSON.stringify({
    level:         opts.success ? 'info' : 'warn',
    event:         'message_send_attempt',
    phoneNumberId: opts.phoneNumberId,
    to:            opts.to,
    messageId:     opts.messageId,
    messageType:   opts.messageType,
    templateName:  opts.templateName,
    campaignId:    opts.campaignId,
    sentByUserId:  opts.sentByUserId,
    success:       opts.success,
    errorCode:     opts.errorCode,
    errorMessage:  opts.errorMessage,
    timestamp:     new Date().toISOString(),
  }))
}
