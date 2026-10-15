// Enrich only already-authorized messages. Never infer the sender from the
// contact's current assignment: a thread may contain several business numbers.
export const REACTION_TARGET_JOIN = `LEFT JOIN LATERAL (
  SELECT candidate.* FROM (
    SELECT cn.whatsapp_line_id AS line_id,cm.phone_number_id,cm.wamid AS target_wamid,
      cm.message_type,'cloud'::text AS line_type,0 AS priority
    FROM cloud_messages cm
    JOIN cloud_conversations cc ON cc.id=cm.conversation_id AND cc.phone_number_id=cm.phone_number_id
    JOIN cloud_numbers cn ON cn.phone_number_id=cm.phone_number_id
    WHERE (cm.id=recent.id OR cm.wamid=recent.evolution_message_id)
      AND REPLACE(cc.contact_phone,'+','')=REPLACE(recent.phone_number,'+','')
      AND ($1::uuid[] IS NULL OR cn.whatsapp_line_id=ANY($1::uuid[]))
    UNION ALL
    SELECT wl.id,cn.phone_number_id,recent.evolution_message_id,
      COALESCE(to_jsonb(wm)->'metadata'->>'media_type','text'),wl.line_type,1
    FROM whatsapp_messages wm
    LEFT JOIN campaign_recipients cr ON cr.id=(to_jsonb(wm)->>'campaign_recipient_id')::uuid
    JOIN whatsapp_lines wl ON wl.id::text=COALESCE(to_jsonb(wm)->'metadata'->>'line_id',cr.line_id::text)
    LEFT JOIN cloud_numbers cn ON cn.whatsapp_line_id=wl.id AND wl.line_type='cloud'
    WHERE wm.id=recent.id AND ($1::uuid[] IS NULL OR wl.id=ANY($1::uuid[]))
  ) candidate ORDER BY priority LIMIT 1
) reaction_target ON true`

// Events remain in the existing delivery logs. Latest event per actor wins;
// an empty emoji removes a reaction and a failed attempt preserves the prior one.
// Both the target and event must match the contact AND the business line.
export const MESSAGE_REACTIONS_JOIN = `LEFT JOIN LATERAL (
  WITH events AS (
    SELECT cm.id,CASE WHEN cm.direction='inbound' THEN 'contact' ELSE 'self' END AS actor,
      COALESCE(cm.content->'reaction'->>'emoji','') AS emoji,cm.status,
      COALESCE(cm.sent_at,cm.created_at) AS at
    FROM cloud_messages cm JOIN cloud_conversations cc ON cc.id=cm.conversation_id
    WHERE cm.phone_number_id=reaction_target.phone_number_id AND cm.message_type='reaction'
      AND REPLACE(cc.contact_phone,'+','')=REPLACE(recent.phone_number,'+','')
      AND COALESCE(cm.content->'reaction'->>'message_id',cm.content->'reaction'->>'messageId')=reaction_target.target_wamid
    UNION ALL
    SELECT event.id,CASE WHEN event.direction='inbound' THEN 'contact' ELSE 'self' END,
      event.metadata->>'emoji',event.status::text,COALESCE(event.sent_at,event.created_at)
    FROM whatsapp_messages event
    WHERE event.phone_number IN (REPLACE(recent.phone_number,'+',''),'+'||REPLACE(recent.phone_number,'+',''))
      AND event.metadata->>'kind'='reaction'
      AND event.metadata->>'line_id'=reaction_target.line_id::text
      AND event.metadata->>'target_wamid'=reaction_target.target_wamid
  ), accepted AS (
    SELECT DISTINCT ON (actor) actor,emoji FROM events
    WHERE status IN ('sent','delivered','read','received')
    ORDER BY actor,at DESC,id DESC
  ) SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('actor',actor,'emoji',emoji) ORDER BY actor)
    FROM accepted WHERE emoji<>''),'[]'::jsonb) AS reactions,
    (SELECT CASE WHEN status='failed' THEN 'WhatsApp no pudo aplicar la última reacción.' END
     FROM events WHERE actor='self' ORDER BY at DESC,id DESC LIMIT 1) AS reaction_error
) reaction_state ON true`
