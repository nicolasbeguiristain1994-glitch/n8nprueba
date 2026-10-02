import { cloudMessageTextSql } from '@/lib/cloud-api/message-content'

// $1: accessible WhatsApp line IDs; NULL means the authenticated super-admin.
// Existing campaign/Evolution logs retain their current visibility. Cloud data
// is only added for lines the reader is authorized to see. WAMID deduplicates
// messages already recorded in both stores without copying or replaying events.
export const CONVERSATION_MESSAGES_CTE = `WITH conversation_messages AS (
  SELECT wm.id,wm.phone_number,wm.message_body,wm.direction::text AS direction,
    wm.status::text AS status,wm.created_at,wm.evolution_message_id,wm.campaign_id
  FROM whatsapp_messages wm
  UNION ALL
  SELECT cm.id,cc.contact_phone AS phone_number,
    ${cloudMessageTextSql('cm.content','cm.message_type')} AS message_body,
    CASE WHEN cm.direction='inbound' THEN 'inbound' ELSE 'outbound' END AS direction,
    CASE WHEN cm.direction='inbound' THEN 'received' ELSE cm.status END AS status,
    COALESCE(cm.sent_at,cm.created_at) AS created_at,cm.wamid AS evolution_message_id,cm.campaign_id
  FROM cloud_messages cm
  JOIN cloud_conversations cc ON cc.id=cm.conversation_id
  JOIN cloud_numbers cn ON cn.phone_number_id=cm.phone_number_id
  WHERE ($1::uuid[] IS NULL OR cn.whatsapp_line_id=ANY($1::uuid[]))
    AND NOT EXISTS (SELECT 1 FROM whatsapp_messages legacy
      WHERE cm.wamid IS NOT NULL AND legacy.evolution_message_id=cm.wamid)
)`
