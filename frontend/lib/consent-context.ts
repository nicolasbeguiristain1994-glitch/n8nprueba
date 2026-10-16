import { query } from './db'
import { canonicalContactAgent } from './contact-account-identity'

type Reader = {query: (sql:string,params:unknown[])=>Promise<{rows:Record<string,unknown>[]}>}
export type ConsentContext = {agentCode?:string|null;contactId?:string|null;campaignId?:string|null;
  provider?:'cloud'|'evolution';sourceId?:string;contextWamid?:string;messageId?:string}
export type ConsentIdentity = {agent:string|null;campaignId:string|null;sourceKey:string|null}
export async function resolveConsentIdentity(phone:string,context:ConsentContext={},db?:Reader):Promise<ConsentIdentity> {
  const read = async(sql:string,params:unknown[])=>db?(await db.query(sql,params)).rows:query<Record<string,unknown>>(sql,params)
  const sourceKey=context.sourceId?`${context.provider??'cloud'}:${context.sourceId}`:null
  const result=(agent:unknown,campaign:unknown=null):ConsentIdentity=>({agent:canonicalContactAgent(typeof agent==='string'?agent:null),campaignId:typeof campaign==='string'?campaign:null,sourceKey})
  if(context.agentCode) return result(context.agentCode,context.campaignId)
  if(context.contactId) {
    const rows=await read(`SELECT panel FROM contacts WHERE id=$1 AND phone_number IN($2,'+'||$2)`,[context.contactId,phone])
    if(rows.length===1) return result(rows[0].panel,context.campaignId)
  }
  if(context.campaignId) {
    const rows=await read(`SELECT DISTINCT COALESCE(r.agent_code,contact_agent_key(c.panel)) AS agent
      FROM campaign_recipients r LEFT JOIN contacts c ON c.id=r.contact_id
      WHERE r.campaign_id=$1 AND regexp_replace(r.phone_number,'[^0-9]','','g')=$2`,[context.campaignId,phone])
    if(rows.length===1 && rows[0].agent) return result(rows[0].agent,context.campaignId)
    // An ambiguous campaign must not borrow another campaign's identity.
    return result(null,context.campaignId)
  }
  if(context.sourceId) {
    const rows=await read(`WITH source_line AS (
        SELECT wl.id FROM whatsapp_lines wl LEFT JOIN cloud_numbers cn ON cn.whatsapp_line_id=wl.id
        WHERE ($2='cloud' AND cn.phone_number_id=$3) OR ($2='evolution' AND wl.evolution_instance=$3)
      ), inbound_time AS (
        SELECT min(at) at FROM (
          SELECT created_at at FROM whatsapp_messages WHERE evolution_message_id=$5 AND direction='inbound'
          UNION ALL SELECT COALESCE(sent_at,created_at) FROM cloud_messages WHERE wamid=$5 AND direction='inbound'
        ) t
      ), history AS (
        SELECT COALESCE(w.metadata->>'agent_code',r.agent_code,contact_agent_key(c.panel)) agent,
          w.campaign_id,w.evolution_message_id wamid,COALESCE(w.sent_at,w.created_at) at
        FROM whatsapp_messages w LEFT JOIN campaign_recipients r ON r.id=w.campaign_recipient_id
        LEFT JOIN contacts c ON c.id=w.contact_id
        WHERE w.phone_number IN($1,'+'||$1) AND w.direction='outbound'
          AND w.status IN ('sent','delivered','read')
          AND (w.metadata->>'line_id' IN (SELECT id::text FROM source_line) OR r.line_id IN (SELECT id FROM source_line)
            OR EXISTS(SELECT 1 FROM cloud_messages cm WHERE cm.wamid=w.evolution_message_id AND cm.phone_number_id=$3 AND $2='cloud'))
        UNION ALL
        SELECT COALESCE(m.content->>'agentCode',r.agent_code,contact_agent_key(c.panel)),m.campaign_id,m.wamid,COALESCE(m.sent_at,m.created_at)
        FROM cloud_messages m JOIN cloud_conversations cc ON cc.id=m.conversation_id
        LEFT JOIN campaign_recipients r ON r.campaign_id=m.campaign_id AND regexp_replace(r.phone_number,'[^0-9]','','g')=$1
        LEFT JOIN contacts c ON c.id=r.contact_id
        WHERE $2='cloud' AND m.phone_number_id=$3 AND regexp_replace(cc.contact_phone,'[^0-9]','','g')=$1
          AND m.direction='outbound' AND m.status IN ('sent','delivered','read')
      ) SELECT agent,campaign_id FROM history
        WHERE at<=COALESCE((SELECT at FROM inbound_time),NOW())
          AND ($4::text IS NULL OR wamid=$4)
        ORDER BY at DESC FETCH FIRST 1 ROW WITH TIES`,[phone,context.provider??'cloud',context.sourceId,context.contextWamid??null,context.messageId??null])
    if(rows[0]) return rows.every(row=>row.agent===rows[0].agent)
      ? result(rows[0].agent,rows[0].campaign_id) : result(null)
    // A quoted message that cannot be attributed must not fall back to another agent.
    if(context.contextWamid) return result(null)
  }
  const agents=await read(`SELECT DISTINCT agent FROM (
    SELECT contact_agent_key(panel) agent FROM contacts WHERE phone_number IN($1,'+'||$1) AND deleted_at IS NULL
    UNION SELECT contact_agent_key(a->>'panel') FROM contacts c CROSS JOIN LATERAL jsonb_array_elements(c.casino_accounts) a
      WHERE c.phone_number IN($1,'+'||$1) AND c.deleted_at IS NULL
  ) a WHERE agent IS NOT NULL LIMIT 2`,[phone])
  return result(agents.length===1?agents[0].agent:null)
}
