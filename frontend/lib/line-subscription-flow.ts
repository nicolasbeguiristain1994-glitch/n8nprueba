import { withTransaction } from '@/lib/db'
import type { InboundSubscriptionMessage, SubscriptionSettings } from './line-subscriptions'
import { isSubscriptionStop, normalizeSubscriptionRequest, normalizeSubscriptionText, subscriptionPhone, subscriptionWelcome } from './line-subscription-message'
import { sendSubscriptionReply } from './line-subscription-reply'

/** Only authenticated, persisted, direct Cloud messages reach this handler. */
export async function processSubscriptionFlow(input: InboundSubscriptionMessage & { profileName?: string | null }): Promise<boolean> {
  const phone = subscriptionPhone(input.phone)
  if (input.provider !== 'cloud' || !phone || !input.messageId || !input.sourceId || !input.text) return false
  const stop = isSubscriptionStop(input.text)
  let occurredAt = new Date(Number(input.timestamp) * 1000)
  if (Number(input.timestamp) <= 0 || !Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now()+300_000) {
    if (!stop) return false
    occurredAt = new Date()
  }
  const result = await withTransaction(async db => {
    const {rows:[settings]} = await db.query<SubscriptionSettings>(`SELECT s.* FROM whatsapp_subscription_settings s
      JOIN cloud_numbers n ON n.whatsapp_line_id=s.line_id JOIN whatsapp_lines l ON l.id=s.line_id
      WHERE n.phone_number_id=$1 AND l.line_type='cloud' AND s.confirmation_flow IS NOT NULL FOR SHARE OF s`, [input.sourceId])
    if (!settings?.confirmation_flow) return {handled:false,eventId:null}
    const request = normalizeSubscriptionRequest(input.text) === normalizeSubscriptionRequest(settings.message_text)
    const ok = normalizeSubscriptionText(input.text) === 'ok'
    if (!request && !ok && !stop) return {handled:false,eventId:null}
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[settings.line_id+':'+phone])
    const {rows:[receipt]} = await db.query<{handled:boolean;event_id:string|null}>(
      'SELECT handled,event_id FROM whatsapp_subscription_flow_receipts WHERE line_id=$1 AND message_id=$2',[settings.line_id,input.messageId])
    if (receipt) return {handled:receipt.handled,eventId:receipt.event_id}
    const {rows:[current]} = await db.query<{status:string;event_id:string;occurred_at:Date;revision:string}>(`SELECT c.*,e.revision
      FROM whatsapp_line_subscribers c JOIN whatsapp_subscription_events e ON e.id=c.event_id
      WHERE c.line_id=$1 AND c.contact_phone=$2`,[settings.line_id,phone])
    const fresh = !current || occurredAt > new Date(current.occurred_at)
      || (occurredAt.getTime() === new Date(current.occurred_at).getTime() && (stop || current.status === 'pending'))
    const active = settings.enabled && occurredAt >= new Date(settings.active_since)
    const pending = current?.status === 'pending' && current.revision === settings.revision
    let event: 'pending'|'subscribed'|'unsubscribed'|null = null
    if (stop && fresh) event = 'unsubscribed'
    else if (active && fresh && ok && pending) event = 'subscribed'
    else if (active && fresh && request && !(current?.revision === settings.revision && ['pending','subscribed'].includes(current.status))) event = 'pending'
    const handled = stop || request || event === 'subscribed'
    let eventId: string | null = null
    if (event) {
      let body = event === 'unsubscribed' ? settings.confirmation_flow.goodbye : settings.confirmation_flow.confirmation
      let expectedMessage = settings.message_text
      if (event === 'pending') {
        const {rows:names} = await db.query<{name:string}>(`SELECT DISTINCT NULLIF(trim(first_name),'') AS name FROM contacts
          WHERE regexp_replace(phone_number,'[^0-9]','','g')=$1 AND deleted_at IS NULL AND NULLIF(trim(first_name),'') IS NOT NULL LIMIT 2`,[phone])
        body = subscriptionWelcome(settings.confirmation_flow.welcome, names.length === 1 ? names[0].name : input.profileName ?? null)
      } else if (event === 'subscribed') {
        const {rows:[welcome]} = await db.query<{body:string}>('SELECT body FROM whatsapp_subscription_replies WHERE event_id=$1',[current.event_id])
        expectedMessage = welcome?.body ?? settings.confirmation_flow.welcome
      }
      const {rows:[inserted]} = await db.query<{id:string}>(`INSERT INTO whatsapp_subscription_events
        (line_id,contact_phone,event,provider,message_id,message_text,brand_name,revision,expected_message,occurred_at,request_event_id)
        VALUES($1,$2,$3,'cloud',$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(line_id,provider,message_id) DO NOTHING RETURNING id`,
      [settings.line_id,phone,event,input.messageId,input.text,settings.brand_name,settings.revision,expectedMessage,occurredAt,event==='subscribed'?current.event_id:null])
      if (inserted) {
        eventId = inserted.id
        await db.query(`INSERT INTO whatsapp_line_subscribers(line_id,contact_phone,status,event_id,occurred_at) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(line_id,contact_phone) DO UPDATE SET status=EXCLUDED.status,event_id=EXCLUDED.event_id,occurred_at=EXCLUDED.occurred_at`,
        [settings.line_id,phone,event,eventId,occurredAt])
        await db.query('INSERT INTO whatsapp_subscription_replies(event_id,body) VALUES($1,$2)',[eventId,body])
      }
    }
    await db.query('INSERT INTO whatsapp_subscription_flow_receipts(line_id,message_id,handled,event_id) VALUES($1,$2,$3,$4)',
      [settings.line_id,input.messageId,handled,eventId])
    return {handled,eventId}
  })
  if (result.eventId) await sendSubscriptionReply(result.eventId)
  return result.handled
}
