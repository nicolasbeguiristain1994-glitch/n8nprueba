import { canonicalContactAgent } from './contact-account-identity'

type Read = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>

/** A quoted test is separate from campaign deliveries, but still identifies its agent.
 * Never infer an agent from a campaign's name or borrow the tester's other account.
 */
export async function campaignTestReplyIdentity(read: Read, phone: string, sourceId: string, quotedId: string, inboundId?: string) {
  const rows = await read(`SELECT t.campaign_id, COALESCE(contact_agent_key(c.agent_key), audience.agent) AS agent
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
    WHERE t.phone_number_id=$1::text AND t.provider_message_id=$2::text
      AND regexp_replace(t.phone_number,'[^0-9]','','g')=$3::text
      AND t.status IN ('sent','delivered','read')
      AND t.created_at<=COALESCE((SELECT COALESCE(sent_at,created_at) FROM cloud_messages
        WHERE wamid=$4::text AND phone_number_id=$1::text AND direction='inbound' LIMIT 1),NOW())`,
  [sourceId,quotedId,phone,inboundId??null])
  if (!rows.length) return null
  const first = rows[0]
  const unambiguous = rows.every(row=>row.agent===first.agent && row.campaign_id===first.campaign_id)
  return { agent: unambiguous ? canonicalContactAgent(typeof first.agent==='string'?first.agent:null) : null,
    campaignId: unambiguous && typeof first.campaign_id==='string' ? first.campaign_id : null, isCampaignTest: true as const }
}
