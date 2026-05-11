// Repository para cloud_conversations y cloud_messages.

import { query } from '@/lib/db'

export interface ConversationRow {
  id:                  string
  phone_number_id:     string
  contact_phone:       string
  window_opens_at:     Date | null
  window_expires_at:   Date | null
  window_type:         string | null
  status:              string
  unread_count:        number
  last_message_at:     Date | null
}

export interface UpsertConversationParams {
  phoneNumberId:      string
  contactPhone:       string
  lastMessagePreview: string
}

export const conversationRepository = {

  async findWindow(phoneNumberId: string, contactPhone: string): Promise<{
    windowExpiresAt: Date | null
    windowType:      string | null
  } | null> {
    const rows = await query<{ window_expires_at: Date | null; window_type: string | null }>(
      `SELECT window_expires_at, window_type
       FROM cloud_conversations
       WHERE phone_number_id = $1 AND contact_phone = $2`,
      [phoneNumberId, contactPhone],
    )
    if (!rows[0]) return null
    return { windowExpiresAt: rows[0].window_expires_at, windowType: rows[0].window_type }
  },

  async openWindow(
    phoneNumberId: string,
    contactPhone:  string,
    type:          'customer_initiated' | 'business_initiated',
  ): Promise<void> {
    const now     = new Date()
    const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    await query(
      `INSERT INTO cloud_conversations
         (phone_number_id, contact_phone, window_opens_at, window_expires_at, window_type, last_message_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $3, NOW())
       ON CONFLICT (phone_number_id, contact_phone) DO UPDATE
         SET window_opens_at   = $3,
             window_expires_at = $4,
             window_type       = $5,
             last_message_at   = $3,
             updated_at        = NOW()`,
      [phoneNumberId, contactPhone, now, expires, type],
    )
  },

  async upsertWithMessage(p: UpsertConversationParams): Promise<string> {
    const rows = await query<{ id: string }>(
      `INSERT INTO cloud_conversations
         (phone_number_id, contact_phone, last_message_at, last_message_preview,
          unread_count, status, updated_at)
       VALUES ($1, $2, NOW(), $3, 1, 'open', NOW())
       ON CONFLICT (phone_number_id, contact_phone) DO UPDATE
         SET last_message_at      = NOW(),
             last_message_preview = $3,
             unread_count         = cloud_conversations.unread_count + 1,
             status               = 'open',
             updated_at           = NOW()
       RETURNING id`,
      [p.phoneNumberId, p.contactPhone, p.lastMessagePreview],
    )
    return rows[0].id
  },

  async upsertForOutbound(phoneNumberId: string, contactPhone: string): Promise<string> {
    const rows = await query<{ id: string }>(
      `INSERT INTO cloud_conversations (phone_number_id, contact_phone, status, last_message_at)
       VALUES ($1, $2, 'open', NOW())
       ON CONFLICT (phone_number_id, contact_phone) DO UPDATE
         SET last_message_at = NOW(), updated_at = NOW()
       RETURNING id`,
      [phoneNumberId, contactPhone],
    )
    return rows[0].id
  },

  async getWindowsExpiringIn(phoneNumberId: string, withinMinutes: number): Promise<
    Array<{ contactPhone: string; expiresAt: Date }>
  > {
    const rows = await query<{ contact_phone: string; window_expires_at: Date }>(
      `SELECT contact_phone, window_expires_at
       FROM cloud_conversations
       WHERE phone_number_id = $1
         AND window_expires_at BETWEEN NOW() AND NOW() + ($2 || ' minutes')::interval
         AND status = 'open'
       ORDER BY window_expires_at`,
      [phoneNumberId, String(withinMinutes)],
    )
    return rows.map(r => ({ contactPhone: r.contact_phone, expiresAt: r.window_expires_at }))
  },

  // Best-effort: actualiza el nombre visible del contacto en la tabla cross-domain.
  // Se ignoran errores silenciosamente (la tabla puede no existir en todos los entornos).
  async updateContactDisplayName(phone: string, name: string): Promise<void> {
    await query(
      `UPDATE contacts SET whatsapp_name = $1, updated_at = NOW() WHERE phone = $2`,
      [name, phone],
    ).catch(() => {})
  },
}

export const messageRepository = {

  async insertInbound(params: {
    conversationId: string
    phoneNumberId:  string
    wamid:          string
    messageType:    string
    content:        unknown
    timestamp:      string
  }): Promise<void> {
    await query(
      `INSERT INTO cloud_messages
         (conversation_id, phone_number_id, wamid, direction, message_type, content, status, sent_at)
       VALUES ($1, $2, $3, 'inbound', $4, $5, 'delivered', to_timestamp($6::bigint))
       ON CONFLICT (wamid) DO NOTHING`,
      [
        params.conversationId, params.phoneNumberId, params.wamid,
        params.messageType, JSON.stringify(params.content), params.timestamp,
      ],
    )
  },

  async insertEcho(params: {
    conversationId: string
    phoneNumberId:  string
    wamid:          string
    messageType:    string
    content:        unknown
    timestamp:      string
  }): Promise<void> {
    await query(
      `INSERT INTO cloud_messages
         (conversation_id, phone_number_id, wamid, direction, message_type, content, status, sent_at)
       VALUES ($1, $2, $3, 'echo', $4, $5, 'sent', to_timestamp($6::bigint))
       ON CONFLICT (wamid) DO NOTHING`,
      [
        params.conversationId, params.phoneNumberId, params.wamid,
        params.messageType, JSON.stringify(params.content), params.timestamp,
      ],
    )
  },

  async insertOutbound(params: {
    id:              string
    conversationId:  string
    phoneNumberId:   string
    wamid:           string
    messageType:     string
    content:         unknown
    templateName?:   string
    campaignId?:     string
    sentByUserId?:   string
  }): Promise<void> {
    await query(
      `INSERT INTO cloud_messages
         (id, conversation_id, phone_number_id, wamid, direction, message_type,
          content, status, sent_at, template_name, campaign_id, sent_by_user_id)
       VALUES ($1, $2, $3, $4, 'outbound', $5, $6, 'sent', NOW(), $7, $8, $9)`,
      [
        params.id, params.conversationId, params.phoneNumberId, params.wamid,
        params.messageType, JSON.stringify(params.content),
        params.templateName ?? null, params.campaignId ?? null, params.sentByUserId ?? null,
      ],
    )
  },

  async insertQueued(params: {
    id:            string
    conversationId: string
    phoneNumberId: string
    messageType:   string
    content:       unknown
    campaignId?:   string
    sentByUserId?: string
  }): Promise<void> {
    await query(
      `INSERT INTO cloud_messages
         (id, conversation_id, phone_number_id, direction, message_type, content,
          status, queued_at, campaign_id, sent_by_user_id)
       VALUES ($1, $2, $3, 'outbound', $4, $5, 'queued', NOW(), $6, $7)`,
      [
        params.id, params.conversationId, params.phoneNumberId,
        params.messageType, JSON.stringify(params.content),
        params.campaignId ?? null, params.sentByUserId ?? null,
      ],
    )
  },

  async updateStatus(wamid: string, status: string, extras: {
    errorCode?:       number | null
    errorTitle?:      string | null
    errorDetails?:    string | null
    pricingModel?:    string | null
    pricingCategory?: string | null
    billable?:        boolean | null
  } = {}): Promise<void> {
    await query(
      `UPDATE cloud_messages
       SET status            = $1,
           delivered_at      = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END,
           read_at           = CASE WHEN $1 = 'read'      THEN NOW() ELSE read_at      END,
           failed_at         = CASE WHEN $1 = 'failed'    THEN NOW() ELSE failed_at    END,
           error_code        = $2,
           error_title       = $3,
           error_details     = $4,
           pricing_model     = $5,
           pricing_category  = $6,
           billable          = $7
       WHERE wamid = $8`,
      [
        status,
        extras.errorCode ?? null,
        extras.errorTitle ?? null,
        extras.errorDetails ?? null,
        extras.pricingModel ?? null,
        extras.pricingCategory ?? null,
        extras.billable ?? null,
        wamid,
      ],
    )
  },

  async findPhoneNumberIdByWamid(wamid: string): Promise<string | null> {
    const rows = await query<{ phone_number_id: string }>(
      `SELECT phone_number_id FROM cloud_messages WHERE wamid = $1`,
      [wamid],
    )
    return rows[0]?.phone_number_id ?? null
  },

  // Usado por el worker después de un envío exitoso (el wamid llega de Meta).
  async markSent(messageId: string, wamid: string): Promise<void> {
    await query(
      `UPDATE cloud_messages SET wamid = $1, status = 'sent', sent_at = NOW() WHERE id = $2`,
      [wamid, messageId],
    )
  },

  // Usado por el worker cuando Meta rechaza el mensaje.
  async markError(
    messageId:    string,
    errorCode:    number,
    errorTitle:   string,
    errorDetails: string,
  ): Promise<void> {
    await query(
      `UPDATE cloud_messages
       SET error_code = $1, error_title = $2, error_details = $3, failed_at = NOW()
       WHERE id = $4`,
      [errorCode, errorTitle, errorDetails, messageId],
    )
  },
}
