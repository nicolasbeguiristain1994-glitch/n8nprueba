import { AGENT_MESSAGES_CTE } from './agent-messages'
import { agentScope } from './agent-scope'
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
    AND COALESCE(to_jsonb(wm)->'metadata'->>'kind','')<>'reaction'
    AND NOT EXISTS (SELECT 1 FROM cloud_messages reaction WHERE reaction.wamid=wm.evolution_message_id AND reaction.message_type='reaction')
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
  WHERE ${cloudScope} AND cm.message_type<>'reaction' AND ($1::uuid[] IS NULL OR cn.whatsapp_line_id=ANY($1::uuid[]))
    AND NOT EXISTS (SELECT 1 FROM whatsapp_messages legacy
      WHERE cm.wamid IS NOT NULL AND legacy.evolution_message_id=cm.wamid)
)` }
export const CONVERSATION_MESSAGES_CTE = messagesCte()
export function scopedConversationMessages(user: ContactAccessUser, paramBase: number, requested?: string) {
  const agents = agentScope(user)
  if (agents !== null || requested) {
    const contact=agents===null ? contactPhoneScope(user,'m.phone_number',paramBase+2,user.role==='admin') : {sql:`NOT EXISTS(SELECT 1 FROM contacts deleted_contact WHERE deleted_contact.deleted_at IS NOT NULL
      AND REPLACE(deleted_contact.phone_number,'+','')=m.phone_number)
      AND (NOT EXISTS(SELECT 1 FROM operator_contact_visibility v WHERE v.operator_id=$${paramBase+3}::uuid)
      OR EXISTS(SELECT 1 FROM contacts scoped_contact JOIN operator_contact_visibility v ON v.contact_id=scoped_contact.id
        WHERE v.operator_id=$${paramBase+3}::uuid AND scoped_contact.deleted_at IS NULL AND scoped_contact.panel=m.agent_key
          AND REPLACE(scoped_contact.phone_number,'+','')=m.phone_number))`,params:[user.user_id]}
    return {sql: `${AGENT_MESSAGES_CTE}, conversation_messages AS (
      SELECT * FROM attributed_agent_messages m
      WHERE ${contact.sql} AND ($${paramBase+1}::text[] IS NULL OR m.agent_key=ANY($${paramBase+1}::text[]))
        AND ($${paramBase+2}::text='all' OR COALESCE(m.agent_key,'none')=$${paramBase+2})
        AND ($${paramBase+1}::text[] IS NOT NULL OR $1::uuid[] IS NULL OR m.line_id=ANY($1::uuid[]) OR m.line_id IS NULL)
    )`,params:[agents,requested || 'all',...contact.params]}
  }
  const legacy = contactPhoneScope(user, 'wm.phone_number', paramBase, user.role === 'admin')
  const cloud = contactPhoneScope(user, 'cc.contact_phone', paramBase, true)
  return { sql: messagesCte(legacy.sql, cloud.sql), params: legacy.params }
}
