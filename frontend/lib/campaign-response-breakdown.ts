import { query } from '@/lib/db'
import { CAMPAIGN_REPLIES_SQL } from '@/lib/campaign-replies'
import { responseCandidates, summarizeResponses, type CampaignResponseSummary, type ResponseRecord } from '@/lib/campaign-response-summary'

// Call only with campaign IDs already scoped by the caller's authorization.
export async function campaignResponseBreakdowns(ids: string[]): Promise<Map<string, CampaignResponseSummary>> {
  const result = new Map<string, CampaignResponseSummary>()
  if (!ids.length) return result
  const configs = await query<{id: string; components: unknown; template_params: unknown}>(`
    SELECT c.id,c.template_params,t.components FROM campaigns c
    LEFT JOIN whatsapp_templates t ON t.id=c.template_id WHERE c.id=ANY($1::uuid[])`, [ids])
  const rows = await query<{campaign_id: string; phone: string; message_type: string; content: unknown; count: number}>(`
    SELECT c.id AS campaign_id,regexp_replace(COALESCE(cc.contact_phone,wm.phone_number),'[^0-9]','','g') AS phone,
      CASE WHEN replies.source='legacy' THEN 'text' ELSE cm.message_type END AS message_type,
      CASE WHEN replies.source='legacy' THEN jsonb_build_object('text',jsonb_build_object('body',wm.message_body)) ELSE cm.content END AS content,
      count(*)::int AS count
    FROM campaigns c CROSS JOIN LATERAL (${CAMPAIGN_REPLIES_SQL}) replies
    LEFT JOIN cloud_messages cm ON replies.source='cloud' AND cm.id=replies.id
    LEFT JOIN cloud_conversations cc ON cc.id=cm.conversation_id
    LEFT JOIN whatsapp_messages wm ON replies.source='legacy' AND wm.id=replies.id
    WHERE c.id=ANY($1::uuid[]) GROUP BY 1,2,3,4`, [ids])
  const grouped = new Map<string, ResponseRecord[]>()
  for (const row of rows) {
    const replies = grouped.get(row.campaign_id) ?? []
    replies.push({ phone: row.phone, candidates: responseCandidates(row.message_type, row.content), count: row.count })
    grouped.set(row.campaign_id, replies)
  }
  for (const config of configs) result.set(config.id, summarizeResponses(config.components, config.template_params, grouped.get(config.id) ?? []))
  return result
}
