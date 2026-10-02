import { CONVERSATION_MESSAGES_CTE } from './conversation-messages'

// Only successful campaign messages establish membership. Replies and manual
// sends keep that history; queued/failed campaigns never label a conversation.
// Use the same visible, deduplicated message source as the inbox itself.
export const conversationInboxCte = (messages = CONVERSATION_MESSAGES_CTE) => `${messages},
  campaign_threads AS (
    SELECT REPLACE(m.phone_number, '+', '') AS phone_number,
      cp.id, cp.name, MAX(m.created_at) AS last_sent_at
    FROM conversation_messages m
    JOIN campaigns cp ON cp.id = m.campaign_id
    WHERE m.direction = 'outbound' AND m.status IN ('sent', 'delivered', 'read')
    GROUP BY REPLACE(m.phone_number, '+', ''), cp.id, cp.name
  ), campaign_history AS (
    SELECT phone_number,
      jsonb_agg(jsonb_build_object('id', id, 'name', name, 'last_sent_at', last_sent_at)
        ORDER BY last_sent_at DESC, id DESC) AS campaigns
    FROM campaign_threads GROUP BY phone_number
  ), latest_messages AS (
    SELECT DISTINCT ON (REPLACE(phone_number, '+', ''))
      REPLACE(phone_number, '+', '') AS phone_number,
      message_body AS last_message, direction AS last_direction,
      status AS last_status, created_at AS last_at
    FROM conversation_messages
    ORDER BY REPLACE(phone_number, '+', ''), created_at DESC, id DESC
  ), inbox AS (
    SELECT DISTINCT ON (lm.phone_number) lm.*, c.id AS contact_id, c.first_name, c.last_name,
      c.segment::text AS segment, COALESCE(ch.campaigns, '[]'::jsonb) AS campaigns
    FROM latest_messages lm
    LEFT JOIN contacts c ON REPLACE(c.phone_number, '+', '') = lm.phone_number
    LEFT JOIN campaign_history ch ON ch.phone_number = lm.phone_number
    ORDER BY lm.phone_number, (c.phone_number = '+' || lm.phone_number) DESC, c.id
  ), filtered_inbox AS (
    SELECT * FROM inbox i
    WHERE ($2::text = 'all'
      OR ($2 = 'none' AND jsonb_array_length(i.campaigns) = 0)
      OR EXISTS (SELECT 1 FROM campaign_threads ct WHERE ct.phone_number = i.phone_number AND ct.id::text = $2))
      AND ($3::text = 'all' OR ($3 = 'none' AND i.segment IS NULL) OR i.segment = $3)
  )`

export const CONVERSATION_INBOX_CTE = conversationInboxCte()
