// Enrich only the selected, already-authorized messages. $1 always contains the
// accessible line IDs, just like scopedConversationMessages. Legacy duplicates
// resolve by WAMID, without exposing media from another contact or hidden line.
export const CONVERSATION_MEDIA_JOIN = `LEFT JOIN LATERAL (
  SELECT cm.message_type AS media_type, cm.content->cm.message_type->>'id' AS media_id,
    cm.content->cm.message_type->>'caption' AS media_caption, cm.phone_number_id
  FROM cloud_messages cm
  JOIN cloud_conversations cc ON cc.id=cm.conversation_id
  JOIN cloud_numbers cn ON cn.phone_number_id=cm.phone_number_id
  WHERE (cm.id=recent.id OR cm.wamid=recent.evolution_message_id)
    AND REPLACE(cc.contact_phone,'+','')=REPLACE(recent.phone_number,'+','')
    AND cm.direction='inbound' AND cm.message_type IN ('image','sticker')
    AND ($1::uuid[] IS NULL OR cn.whatsapp_line_id=ANY($1::uuid[]))
  ORDER BY cm.id LIMIT 1
) media ON true`

export type ConversationMediaRow = {
  media_type: 'image' | 'sticker' | null
  media_id: string | null
  media_caption: string | null
  phone_number_id: string
}

export function conversationMediaUrl(messageId: string, mediaId: string | null) {
  return mediaId && /^\d+$/.test(mediaId)
    ? `/api/conversations/media?message=${encodeURIComponent(messageId)}` : undefined
}
