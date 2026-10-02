import { contactPhoneScope, type ContactAccessUser } from '@/lib/contact-visibility'
import { cloudMessageTextSql } from '@/lib/cloud-api/message-content'

// $1: accessible WhatsApp line IDs; NULL means the authenticated super-admin.
// Contact scope applies to both stores. Cloud data and its duplicated legacy
// rows additionally require an accessible line. WAMID deduplicates
// messages already recorded in both stores without copying or replaying events.
function messagesCte(legacyScope = 'TRUE', cloudScope = 'TRUE') { return `WITH conversation_messages AS (
  SELECT wm.id,wm.phone_number,wm.message_body,wm.direction::text AS direction,
    wm.status::text AS status,wm.created_at,wm.evolution_message_id,wm.campaign_id
  FROM whatsapp_messages wm
  WHERE ${legacyScope}
    AND NOT EXISTS (SELECT 1 FROM cloud_messages linked
      JOIN cloud_numbers linked_number ON linked_number.phone_number_id=linked.phone_number_id
      WHERE linked.wamid=wm.evolution_message_id
      AND NOT COALESCE(($1::uuid[] IS NULL OR linked_number.whatsapp_line_id=ANY($1::uuid[])), FALSE))
  UNION ALL
  SELECT cm.id,cc.contact_phone AS phone_number,
    ${cloudMessageTextSql('cm.content','cm.message_type')} AS message_body,
    CASE WHEN cm.direction='inbound' THEN 'inbound' ELSE 'outbound' END AS direction,
    CASE WHEN cm.direction='inbound' THEN 'received' ELSE cm.status END AS status,
    COALESCE(cm.sent_at,cm.created_at) AS created_at,cm.wamid AS evolution_message_id,cm.campaign_id
  FROM cloud_messages cm
  JOIN cloud_conversations cc ON cc.id=cm.conversation_id
  JOIN cloud_numbers cn ON cn.phone_number_id=cm.phone_number_id
  WHERE ${cloudScope} AND ($1::uuid[] IS NULL OR cn.whatsapp_line_id=ANY($1::uuid[]))
    AND NOT EXISTS (SELECT 1 FROM whatsapp_messages legacy
      WHERE cm.wamid IS NOT NULL AND legacy.evolution_message_id=cm.wamid)
)` }
export const CONVERSATION_MESSAGES_CTE = messagesCte()
export function scopedConversationMessages(user: ContactAccessUser, paramBase: number) {
  const legacy = contactPhoneScope(user, 'wm.phone_number', paramBase, user.role === 'admin')
  const cloud = contactPhoneScope(user, 'cc.contact_phone', paramBase, true)
  return { sql: messagesCte(legacy.sql, cloud.sql), params: legacy.params }
}
