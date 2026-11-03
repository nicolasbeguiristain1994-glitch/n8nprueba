import { canonicalContactAgent } from './contact-account-identity'

type Read = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>

/** Test sends are separate from campaign deliveries, but still identify their agent.
 * Never infer an agent from a campaign's name or borrow the tester's other account.
 * Unquoted replies need a persisted inbound within 24 hours, after the last real send.
 */
export async function campaignTestReplyIdentity(read: Read, phone: string, sourceId: string, quotedId: string|null, inboundId?: string, after?: string) {
  const rows = await read(`WITH inbound_time AS (
      SELECT COALESCE(m.sent_at,m.created_at) AS at FROM cloud_messages m
      JOIN cloud_conversations cc ON cc.id=m.conversation_id
      WHERE m.wamid=$4::text AND m.phone_number_id=$1::text AND m.direction='inbound'
        AND regexp_replace(cc.contact_phone,'[^0-9]','','g')=$3::text LIMIT 1
    ) SELECT t.campaign_id, COALESCE(contact_agent_key(c.agent_key), audience.agent) AS agent
    FROM campaign_test_sends t LEFT JOIN campaigns c ON c.id=t.campaign_id
    LEFT JOIN LATERAL (
      SELECT CASE WHEN count(*)>0 AND count(agent)=count(*) AND count(DISTINCT agent)=1 THEN min(agent) END AS agent
      FROM (
        SELECT COALESCE(r.agent_code,contact_agent_key(a.panel)) AS agent
        FROM campaign_recipients r LEFT JOIN contacts a ON a.id=r.contact_id WHERE r.campaign_id=c.id
        UNION ALL
        SELECT contact_agent_key(a.panel) FROM contact_list_members m JOIN contacts a ON a.id=m.contact_id
        WHERE m.list_id=c.list_id AND NOT EXISTS(SELECT 1 FROM campaign_recipients r WHERE r.campaign_id=c.id)
      ) agents
    ) audience ON true
    WHERE t.phone_number_id=$1::text AND t.provider_message_id IS NOT NULL
      AND ($2::text IS NULL OR t.provider_message_id=$2::text)
      AND regexp_replace(t.phone_number,'[^0-9]','','g')=$3::text
      AND t.status IN ('sent','delivered','read')
      AND t.created_at<=COALESCE((SELECT at FROM inbound_time),NOW())
      AND ($2::text IS NOT NULL OR (
        t.created_at>=(SELECT at FROM inbound_time)-interval '24 hours'
        AND t.created_at>COALESCE($5::timestamptz,'-infinity'::timestamptz)
      ))
    ORDER BY CASE WHEN $2::text IS NULL THEN t.created_at END DESC FETCH FIRST 1 ROW WITH TIES`,
  [sourceId,quotedId,phone,inboundId??null,after??null])
  if (!rows.length) return null
  const first = rows[0]
  const unambiguous = rows.every(row=>row.agent===first.agent && row.campaign_id===first.campaign_id)
  return { agent: unambiguous ? canonicalContactAgent(typeof first.agent==='string'?first.agent:null) : null,
    campaignId: unambiguous && typeof first.campaign_id==='string' ? first.campaign_id : null, isCampaignTest: true as const }
}
