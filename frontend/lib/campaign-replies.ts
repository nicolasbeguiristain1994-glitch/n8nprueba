// Campaign sends go through whatsapp_messages + campaign_recipients even when
// Meta is the provider. Direct Cloud sends use cloud_messages. Inbound webhooks
// use cloud_messages. Normalize both outbound stores before attributing replies.
const CAMPAIGN_SENDS_SQL = `
  SELECT sent.id,sent.campaign_id,sent.wamid,sent.phone_number_id,
    regexp_replace(conversation.contact_phone,'[^0-9]','','g') AS phone,
    COALESCE(sent.sent_at,sent.created_at) AS sent_at
  FROM cloud_messages sent JOIN cloud_conversations conversation ON conversation.id=sent.conversation_id
  WHERE sent.direction='outbound' AND sent.status IN ('sent','delivered','read')
  UNION ALL
  SELECT sent.id,sent.campaign_id,COALESCE(sent.evolution_message_id,sent.whatsapp_message_id) AS wamid,
    sender.phone_number_id,regexp_replace(sent.phone_number,'[^0-9]','','g') AS phone,
    COALESCE(sent.sent_at,sent.created_at) AS sent_at
  FROM whatsapp_messages sent
  JOIN LATERAL (
    SELECT recipient.line_id FROM campaign_recipients recipient
    WHERE recipient.campaign_id=sent.campaign_id
      AND (recipient.id=COALESCE(sent.campaign_recipient_id,sent.original_campaign_recipient_id)
        OR regexp_replace(recipient.phone_number,'[^0-9]','','g')=regexp_replace(sent.phone_number,'[^0-9]','','g'))
    ORDER BY (recipient.id=COALESCE(sent.campaign_recipient_id,sent.original_campaign_recipient_id)) DESC NULLS LAST,
      (recipient.evolution_message_id=COALESCE(sent.evolution_message_id,sent.whatsapp_message_id)) DESC NULLS LAST,
      recipient.sent_at DESC NULLS LAST,recipient.id DESC LIMIT 1
  ) recipient ON true
  JOIN cloud_numbers sender ON sender.whatsapp_line_id=recipient.line_id
  WHERE sent.direction='outbound' AND sent.status IN ('sent','delivered','read')
    AND sent.campaign_id IS NOT NULL`

// Correlated with campaigns c. Count messages, not unique contacts. Resolve the
// quoted send or the latest prior campaign send across both stores and all
// owners before checking c.id. Sender line + recipient must both match.
export const CAMPAIGN_REPLIES_SQL = `
  WITH campaign_sends AS NOT MATERIALIZED (${CAMPAIGN_SENDS_SQL})
  SELECT reply.id, COALESCE(reply.sent_at,reply.created_at) AS created_at
  FROM cloud_messages reply
  WHERE reply.direction='inbound' AND reply.campaign_id=c.id
  UNION ALL
  SELECT reply.id, COALESCE(reply.sent_at,reply.created_at) AS created_at
  FROM (
    SELECT DISTINCT conversation.id AS conversation_id,sent.phone_number_id,sent.phone
    FROM campaign_sends sent JOIN cloud_conversations conversation
      ON regexp_replace(conversation.contact_phone,'[^0-9]','','g')=sent.phone
        AND conversation.phone_number_id=sent.phone_number_id
    WHERE sent.campaign_id=c.id
  ) conversations
  JOIN cloud_messages reply ON reply.conversation_id=conversations.conversation_id
    AND reply.phone_number_id=conversations.phone_number_id
  WHERE reply.direction='inbound' AND reply.campaign_id IS NULL
    AND (CASE
      WHEN NULLIF(reply.content #>> '{context,id}','') IS NOT NULL THEN (
        SELECT sent.campaign_id FROM campaign_sends sent
        WHERE sent.wamid=reply.content #>> '{context,id}'
          AND sent.phone=conversations.phone
          AND sent.phone_number_id=reply.phone_number_id
          AND sent.sent_at<=COALESCE(reply.sent_at,reply.created_at)
        ORDER BY (sent.campaign_id IS NOT NULL) DESC,sent.sent_at DESC,sent.id DESC LIMIT 1
      )
      ELSE (
        SELECT sent.campaign_id FROM campaign_sends sent
        WHERE sent.phone=conversations.phone
          AND sent.phone_number_id=reply.phone_number_id
          AND sent.campaign_id IS NOT NULL
          AND sent.sent_at<=COALESCE(reply.sent_at,reply.created_at)
        ORDER BY sent.sent_at DESC,sent.id DESC LIMIT 1
      ) END)=c.id
  UNION ALL
  SELECT reply.id, reply.created_at FROM whatsapp_messages reply
  WHERE reply.campaign_id=c.id AND reply.direction='inbound'
    AND NOT EXISTS (
      SELECT 1 FROM cloud_messages cloud WHERE cloud.direction='inbound'
        AND (cloud.wamid=reply.evolution_message_id OR cloud.wamid=reply.whatsapp_message_id)
    )`
