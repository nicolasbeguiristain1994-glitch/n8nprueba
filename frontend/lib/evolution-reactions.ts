import { query, withTransaction } from './db'
import { isReactionEmoji } from './message-reactions'
import { sseEmitter } from './sse-events'

export async function receiveEvolutionReaction(input: {
  instance: unknown; phone: string; eventId: string; fromMe: boolean;
  reaction: Record<string, unknown>; timestamp: unknown;
}) {
  const { reaction } = input
  const key = reaction.key as { id?: unknown; remoteJid?: unknown } | undefined
  const time = Number(reaction.senderTimestampMs || Number(input.timestamp) * 1000)
  if (typeof input.instance !== 'string' || !input.eventId || typeof key?.id !== 'string' || !key.id
    || !/^\d{7,15}$/.test(input.phone) || !isReactionEmoji(reaction.text)
    || (key.remoteJid && key.remoteJid !== `${input.phone}@s.whatsapp.net`)
    || !Number.isFinite(time) || time <= 0 || time > Date.now()+300_000) throw new Error('Invalid reaction event')
  const [line] = await query<{ id: string }>(
    "SELECT id FROM whatsapp_lines WHERE evolution_instance=$1 AND line_type='evolution'", [input.instance])
  if (!line) throw new Error('Unknown reaction line')
  await withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['reaction-event:'+input.eventId])
    await client.query(`INSERT INTO whatsapp_messages(phone_number,message_body,direction,status,evolution_message_id,created_at,sent_at,metadata)
    VALUES($1,'[Reacción]',$2::message_direction,$3::message_status,$4,$5,$5,$6::jsonb)
    ON CONFLICT(evolution_message_id) WHERE evolution_message_id IS NOT NULL DO NOTHING`,
    [input.phone,input.fromMe?'outbound':'inbound',input.fromMe?'sent':'received',input.eventId,new Date(time).toISOString(),
      JSON.stringify({kind:'reaction',line_id:line.id,target_wamid:key.id,emoji:reaction.text})])
  })
  sseEmitter.emit('update', {source:'reaction',phone:input.phone})
}
