import { cloudMessageTextSql } from './cloud-api/message-content'

// Resolve across ALL agents before applying grants. Otherwise a newer Bigwin
// campaign could be invisible and its replies incorrectly attributed to Royal.
// Unknown sender/history stays unassigned. A quoted message takes precedence.
export const AGENT_MESSAGES_CTE = `WITH raw_agent_messages AS (
  SELECT wm.id,regexp_replace(wm.phone_number,'[^0-9]','','g') AS phone_number,
    wm.message_body,wm.direction::text,wm.status::text,wm.created_at,
    wm.evolution_message_id,COALESCE(wm.campaign_id,cm.campaign_id) AS campaign_id,wm.template_id,
    COALESCE(wm.line_id,cn.whatsapp_line_id,CASE WHEN to_jsonb(wm)->'metadata'->>'line_id' ~ '^[0-9a-f-]{36}$' THEN (to_jsonb(wm)->'metadata'->>'line_id')::uuid END,cr.line_id) AS line_id,
    NULLIF(wm.agent_key,'none') AS explicit_agent,cm.content #>> '{context,id}' AS context_id
  FROM whatsapp_messages wm
  LEFT JOIN cloud_messages cm ON cm.wamid=wm.evolution_message_id
  LEFT JOIN cloud_numbers cn ON cn.phone_number_id=cm.phone_number_id
  LEFT JOIN LATERAL (
    SELECT r.line_id FROM campaign_recipients r
    WHERE r.campaign_id=wm.campaign_id
      AND regexp_replace(r.phone_number,'[^0-9]','','g')=regexp_replace(wm.phone_number,'[^0-9]','','g')
    ORDER BY r.sent_at DESC NULLS LAST,r.id DESC LIMIT 1
  ) cr ON wm.line_id IS NULL AND cn.whatsapp_line_id IS NULL
  WHERE COALESCE(to_jsonb(wm)->'metadata'->>'kind','')<>'reaction'
    AND NOT EXISTS (SELECT 1 FROM cloud_messages reaction WHERE reaction.wamid=wm.evolution_message_id AND reaction.message_type='reaction')
  UNION ALL
  SELECT cm.id,regexp_replace(cc.contact_phone,'[^0-9]','','g'),
    ${cloudMessageTextSql('cm.content','cm.message_type')},
    CASE WHEN cm.direction='inbound' THEN 'inbound' ELSE 'outbound' END,
    CASE WHEN cm.direction='inbound' THEN 'received' ELSE cm.status END,
    COALESCE(cm.sent_at,cm.created_at),cm.wamid,cm.campaign_id,c.template_id,
    cn.whatsapp_line_id,NULL::text,cm.content #>> '{context,id}'
  FROM cloud_messages cm JOIN cloud_conversations cc ON cc.id=cm.conversation_id
  JOIN cloud_numbers cn ON cn.phone_number_id=cm.phone_number_id
  LEFT JOIN campaigns c ON c.id=cm.campaign_id
  WHERE cm.message_type <> 'reaction' AND NOT EXISTS (SELECT 1 FROM whatsapp_messages wm WHERE cm.wamid IS NOT NULL
    AND (wm.evolution_message_id=cm.wamid OR wm.whatsapp_message_id=cm.wamid))
), message_groups AS (
  SELECT m.*,count(*) FILTER (WHERE (campaign_id IS NOT NULL OR explicit_agent IS NOT NULL) AND direction='outbound'
    AND status IN ('sent','delivered','read')) OVER (
      PARTITION BY phone_number,line_id ORDER BY created_at,id ROWS UNBOUNDED PRECEDING) AS campaign_group
  FROM raw_agent_messages m
), message_history AS (
  SELECT m.*,first_value(campaign_id) OVER (
    PARTITION BY phone_number,line_id,campaign_group ORDER BY created_at,id) AS prior_campaign_id,
    first_value(explicit_agent) OVER (PARTITION BY phone_number,line_id,campaign_group ORDER BY created_at,id) AS prior_explicit_agent
  FROM message_groups m
), attributed_agent_messages AS (
  SELECT m.*,CASE WHEN m.campaign_id IS NOT NULL THEN campaign.agent_key
    WHEN m.explicit_agent IS NOT NULL THEN m.explicit_agent
    WHEN m.line_id IS NULL THEN NULL
    WHEN NULLIF(m.context_id,'') IS NOT NULL THEN COALESCE(quoted.explicit_agent,quoted_campaign.agent_key)
    ELSE COALESCE(m.prior_explicit_agent,origin.agent_key) END AS agent_key
  FROM message_history m
  LEFT JOIN campaigns campaign ON campaign.id=m.campaign_id
  LEFT JOIN campaigns origin ON origin.id=m.prior_campaign_id
  LEFT JOIN raw_agent_messages quoted ON quoted.evolution_message_id=m.context_id
    AND quoted.phone_number=m.phone_number AND quoted.line_id=m.line_id
    AND quoted.direction='outbound' AND quoted.status IN ('sent','delivered','read')
    AND quoted.created_at<=m.created_at
  LEFT JOIN campaigns quoted_campaign ON quoted_campaign.id=quoted.campaign_id
)`

// $1: line grants for unrestricted accounts; $2: permitted agents; $3: inbox.
// Agent grants authorize only the attributed thread, never the entire line.
export const AGENT_CONVERSATION_CTE = `${AGENT_MESSAGES_CTE}, conversation_messages AS (
  SELECT * FROM attributed_agent_messages m
  WHERE ($2::text[] IS NULL OR m.agent_key=ANY($2::text[]))
    AND ($2::text[] IS NOT NULL OR $1::uuid[] IS NULL OR m.line_id=ANY($1::uuid[]) OR m.line_id IS NULL)
    AND COALESCE(m.agent_key,'none')=$3::text
)`
