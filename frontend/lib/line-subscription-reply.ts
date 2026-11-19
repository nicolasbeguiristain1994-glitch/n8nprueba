import { query, withTransaction } from '@/lib/db'
import { sendMessageUseCase } from '@/lib/cloud-api/use-cases/send-message.use-case'
import { getTokenForNumber } from '@/lib/cloud-api/token-store'
import { enforceRateLimit } from '@/lib/cloud-api/rate-limiter'
import { MetaHttpGateway } from '@/lib/cloud-api/infrastructure/meta-http.gateway'

type Reply = {event_id:string;line_id:string;contact_phone:string;event:string;message_id:string;revision:string;body:string;source_id:string}

/** A durable claim precedes any provider call. Ambiguous attempts are never replayed. */
export async function sendSubscriptionReply(eventId: string): Promise<void> {
  const [reply] = await query<Reply>(`SELECT r.event_id,r.body,e.line_id,e.contact_phone,e.event,e.message_id,e.revision,n.phone_number_id AS source_id
    FROM whatsapp_subscription_replies r JOIN whatsapp_subscription_events e ON e.id=r.event_id
    JOIN cloud_numbers n ON n.whatsapp_line_id=e.line_id WHERE r.event_id=$1 AND r.status='queued'`,[eventId])
  if (!reply) return
  // Credentials/rate limiting can safely fail before reserving the attempt.
  const token = await getTokenForNumber(reply.source_id)
  await enforceRateLimit(reply.source_id)
  const claimed = await query(`UPDATE whatsapp_subscription_replies SET status='sending',started_at=NOW()
    WHERE event_id=$1 AND status='queued' RETURNING event_id`,[eventId])
  if (!claimed.length) return
  try {
    await withTransaction(async db => {
      // Serialize sends with subsequent BAJA/OK transitions for this line only.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[reply.line_id+':'+reply.contact_phone])
      const {rows:[source]} = await db.query<{conversation_id:string}>(`SELECT c.id AS conversation_id
        FROM whatsapp_line_subscribers sub JOIN whatsapp_subscription_settings s ON s.line_id=sub.line_id
        JOIN whatsapp_lines l ON l.id=s.line_id JOIN cloud_numbers n ON n.whatsapp_line_id=l.id
        JOIN cloud_conversations c ON c.phone_number_id=n.phone_number_id
        JOIN cloud_messages m ON m.conversation_id=c.id
        WHERE sub.line_id=$1 AND sub.contact_phone=$2 AND sub.event_id=$3 AND s.revision=$4
          AND s.confirmation_flow IS NOT NULL AND (s.enabled OR $5='unsubscribed')
          AND c.contact_phone='+'||$2 AND c.window_expires_at>NOW() AND m.wamid=$6 AND m.direction='inbound'
          AND m.sent_at>NOW()-interval '24 hours' AND n.status='active' AND l.status='active'
          AND l.is_connected=true AND l.sending_enabled=true`,
      [reply.line_id,reply.contact_phone,eventId,reply.revision,reply.event,reply.message_id])
      if (!source) {
        await db.query("UPDATE whatsapp_subscription_replies SET status='skipped',finished_at=NOW() WHERE event_id=$1",[eventId])
        return
      }
      let historyId: string
      if (reply.event === 'unsubscribed') {
        // This narrowly scoped confirmation requires a committed line BAJA and
        // its actual inbound message. It never authorizes any promotional send.
        historyId = eventId
        await query(`INSERT INTO cloud_messages(id,conversation_id,phone_number_id,direction,message_type,content,status,queued_at)
          VALUES($1,$2,$3,'outbound','text',$4::jsonb,'queued',NOW())`,
        [eventId,source.conversation_id,reply.source_id,JSON.stringify({text:{body:reply.body},source:'subscription_baja_confirmation'})])
        // History is committed through a separate connection before HTTP; the
        // enclosing transaction still protects the subscription state.
        const gateway = new MetaHttpGateway(token,{timeoutMs:12000,circuitBreakerKey:`meta:send:${reply.source_id}`})
        const sent = await gateway.post<{messages?:{id:string}[]}>(`/${reply.source_id}/messages`,{
          messaging_product:'whatsapp',recipient_type:'individual',to:reply.contact_phone,type:'text',text:{body:reply.body,preview_url:false},
        })
        const wamid = sent.messages?.[0]?.id
        if (!wamid) throw Error('Missing subscription confirmation message ID')
        await db.query("UPDATE cloud_messages SET wamid=$2,status='sent',sent_at=NOW() WHERE id=$1",[eventId,wamid])
      } else {
        const sent = await sendMessageUseCase.execute({request:{phoneNumberId:reply.source_id,to:'+'+reply.contact_phone,type:'text',text:{body:reply.body}}})
        historyId = sent.messageId
      }
      await db.query("UPDATE whatsapp_subscription_replies SET status='sent',message_id=$2,finished_at=NOW() WHERE event_id=$1",[eventId,historyId])
    })
  } catch {
    if (reply.event === 'unsubscribed') await query(`UPDATE cloud_messages SET status='failed',failed_at=NOW(),
      error_title='confirmation_uncertain',error_details='Respuesta sin confirmación; no se reenvía automáticamente'
      WHERE id=$1 AND status='queued'`,[eventId])
    await query("UPDATE whatsapp_subscription_replies SET status='uncertain',finished_at=NOW() WHERE event_id=$1 AND status='sending'",[eventId])
    console.warn(JSON.stringify({event:'subscription.reply_uncertain',eventId}))
  }
}
