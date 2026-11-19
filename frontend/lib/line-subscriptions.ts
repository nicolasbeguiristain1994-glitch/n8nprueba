import { query, withTransaction } from '@/lib/db'
import { isSubscriptionStop, normalizeSubscriptionText, subscriptionPhone } from './line-subscription-message'
import type { SubscriptionConfirmationFlow } from './line-subscription-message'

export interface SubscriptionSettings {
  line_id: string
  brand_name: string
  message_text: string
  normalized_message: string
  revision: string
  enabled: boolean
  active_since: string | Date
  updated_at: string | Date
  confirmation_flow: SubscriptionConfirmationFlow | null
}

export async function saveSubscriptionSettings(lineId: string, brand: string, message: string, enabled: boolean, flow?: SubscriptionConfirmationFlow | null) {
  const [settings] = await query<SubscriptionSettings>(`
    INSERT INTO whatsapp_subscription_settings(line_id,brand_name,message_text,normalized_message,enabled,confirmation_flow)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)
    ON CONFLICT(line_id) DO UPDATE SET
      revision = CASE WHEN whatsapp_subscription_settings.normalized_message IS DISTINCT FROM EXCLUDED.normalized_message
        OR whatsapp_subscription_settings.brand_name IS DISTINCT FROM EXCLUDED.brand_name
        OR ($7 AND whatsapp_subscription_settings.confirmation_flow IS DISTINCT FROM EXCLUDED.confirmation_flow)
        THEN gen_random_uuid() ELSE whatsapp_subscription_settings.revision END,
      active_since = CASE WHEN whatsapp_subscription_settings.normalized_message IS DISTINCT FROM EXCLUDED.normalized_message
        OR whatsapp_subscription_settings.brand_name IS DISTINCT FROM EXCLUDED.brand_name
        OR ($7 AND whatsapp_subscription_settings.confirmation_flow IS DISTINCT FROM EXCLUDED.confirmation_flow)
        OR (NOT whatsapp_subscription_settings.enabled AND EXCLUDED.enabled)
        THEN date_trunc('second',NOW()) ELSE whatsapp_subscription_settings.active_since END,
      brand_name=EXCLUDED.brand_name, message_text=EXCLUDED.message_text,
      normalized_message=EXCLUDED.normalized_message, enabled=EXCLUDED.enabled,
      confirmation_flow=CASE WHEN $7 THEN EXCLUDED.confirmation_flow ELSE whatsapp_subscription_settings.confirmation_flow END, updated_at=NOW()
    RETURNING *`, [lineId, brand.trim(), message.trim(), normalizeSubscriptionText(message), enabled, flow ? JSON.stringify(flow) : null, flow !== undefined])
  return settings
}

export interface InboundSubscriptionMessage {
  provider: 'cloud' | 'evolution'
  sourceId: string
  phone: string
  text: string
  messageId: string
  timestamp: string | number
  isStop?: boolean
}

/** Called only after provider authentication and inbound / direct-chat validation. */
export async function recordInboundSubscription(input: InboundSubscriptionMessage): Promise<boolean> {
  const phone = subscriptionPhone(input.phone)
  if (!phone || !input.sourceId || !input.messageId || !input.text) return false
  const stop = input.isStop || isSubscriptionStop(input.text)
  const seconds = Number(input.timestamp)
  let occurredAt = new Date(seconds * 1000)
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(occurredAt.getTime())
    || occurredAt.getTime() > Date.now() + 300_000) {
    if (!stop) return false
    occurredAt = new Date() // A malformed timestamp must never discard BAJA.
  }
  return withTransaction(async client => {
    const {rows:[settings]} = await client.query<SubscriptionSettings>(`
      SELECT s.* FROM whatsapp_subscription_settings s
      JOIN whatsapp_lines l ON l.id=s.line_id
      WHERE ($1='cloud' AND l.line_type='cloud' AND EXISTS(
        SELECT 1 FROM cloud_numbers cn WHERE cn.whatsapp_line_id=l.id AND cn.phone_number_id=$2))
        OR ($1='evolution' AND l.line_type='evolution' AND l.evolution_instance=$2)
      LIMIT 1 FOR SHARE OF s`, [input.provider, input.sourceId])
    if (!settings) return false
    if (!stop && (settings.confirmation_flow || !settings.enabled || normalizeSubscriptionText(input.text) !== settings.normalized_message
      || occurredAt < new Date(settings.active_since))) return false

    const event = stop ? 'unsubscribed' : 'subscribed'
    // Serialize a contact's events; event timestamps, not arrival order, decide state.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [settings.line_id + ':' + phone])
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO whatsapp_subscription_events(line_id,contact_phone,event,provider,message_id,message_text,
        brand_name,revision,expected_message,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(line_id,provider,message_id) DO NOTHING RETURNING id`,
    [settings.line_id,phone,event,input.provider,input.messageId,input.text,settings.brand_name,settings.revision,settings.message_text,occurredAt])
    if (!inserted.rows[0]) return true
    await client.query(`
      INSERT INTO whatsapp_line_subscribers(line_id,contact_phone,status,event_id,occurred_at)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(line_id,contact_phone) DO UPDATE
        SET status=EXCLUDED.status,event_id=EXCLUDED.event_id,occurred_at=EXCLUDED.occurred_at
      WHERE whatsapp_line_subscribers.occurred_at < EXCLUDED.occurred_at
        OR (whatsapp_line_subscribers.occurred_at = EXCLUDED.occurred_at AND EXCLUDED.status='unsubscribed')
      RETURNING line_id`, [settings.line_id,phone,event,inserted.rows[0].id,occurredAt])
    // Existing global/agent opt-out handling remains authoritative. A new
    // subscription records evidence but never reactivates a blocked contact.
    return true
  })
}

export class SubscriptionConsentError extends Error {
  constructor(message: string) { super(message); this.name = 'SubscriptionConsentError' }
}

/** Configured lines require their own opt-in for marketing; unrelated lines keep existing behavior. */
export async function assertLineSubscription(lineId: string, rawPhone: string, marketing = true): Promise<void> {
  const phone = subscriptionPhone(rawPhone)
  if (!phone) throw new SubscriptionConsentError('Número de destinatario inválido.')
  const [state] = await query<{ status: string | null }>(`
    SELECT CASE WHEN c.status='subscribed' AND e.revision<>s.revision THEN 'renewal_required' ELSE c.status END AS status
    FROM whatsapp_subscription_settings s
    LEFT JOIN whatsapp_line_subscribers c ON c.line_id=s.line_id AND c.contact_phone=$2
    LEFT JOIN whatsapp_subscription_events e ON e.id=c.event_id
    WHERE s.line_id=$1`, [lineId,phone])
  if (!state) return
  if (state.status === 'unsubscribed') throw new SubscriptionConsentError('El contacto solicitó BAJA en esta línea.')
  if (marketing && state.status !== 'subscribed') throw new SubscriptionConsentError('El contacto todavía no autorizó promociones de esta línea.')
}

export async function assertProviderSubscription(provider: 'cloud' | 'evolution', sourceId: string, phone: string, marketing: boolean) {
  const [line] = await query<{id:string}>(`SELECT l.id FROM whatsapp_lines l
    WHERE ($1='evolution' AND l.line_type='evolution' AND l.evolution_instance=$2)
      OR ($1='cloud' AND l.line_type='cloud' AND EXISTS(SELECT 1 FROM cloud_numbers cn WHERE cn.whatsapp_line_id=l.id AND cn.phone_number_id=$2))
    LIMIT 1`, [provider,sourceId])
  if (line) await assertLineSubscription(line.id,phone,marketing)
}
