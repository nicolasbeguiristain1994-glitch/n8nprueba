import { CAMPAIGN_OUTCOME_SQL } from '@/lib/campaign-stats'
import { STATS_FROM, STATS_TO } from '@/lib/statistics'

// Current result of the latest recipient attempt, dated by its send. Old line
// counters are quota bookkeeping and never contain provider delivery receipts.
export const LINE_OUTCOMES_CTE = `WITH line_outcomes AS (
  SELECT cr.line_id,${CAMPAIGN_OUTCOME_SQL} AS outcome,
    COALESCE(m.sent_at,m.created_at,cr.sent_at) AS sent_at
  FROM campaign_recipients cr
  LEFT JOIN LATERAL (
    SELECT wm.status,wm.created_at,wm.sent_at FROM whatsapp_messages wm
    WHERE wm.campaign_id=cr.campaign_id AND wm.direction='outbound'
      AND regexp_replace(wm.phone_number,'[^0-9]','','g')=regexp_replace(cr.phone_number,'[^0-9]','','g')
    ORDER BY wm.created_at DESC,wm.id DESC LIMIT 1
  ) m ON true
  UNION ALL
  SELECT cn.whatsapp_line_id,cm.status,COALESCE(cm.sent_at,cm.created_at)
  FROM cloud_messages cm
  JOIN cloud_numbers cn ON cn.phone_number_id=cm.phone_number_id
  JOIN cloud_conversations cc ON cc.id=cm.conversation_id
  WHERE cm.direction='outbound'
    AND NOT EXISTS (SELECT 1 FROM whatsapp_messages wm WHERE cm.wamid IS NOT NULL
      AND (wm.evolution_message_id=cm.wamid OR wm.whatsapp_message_id=cm.wamid))
    AND NOT EXISTS (SELECT 1 FROM campaign_recipients cr WHERE cr.campaign_id=cm.campaign_id
      AND regexp_replace(cr.phone_number,'[^0-9]','','g')=regexp_replace(cc.contact_phone,'[^0-9]','','g'))
), line_totals AS (
  SELECT line_id,
    count(*) FILTER (WHERE outcome IN ('sent','delivered','read'))::int AS total_sent,
    count(*) FILTER (WHERE outcome IN ('delivered','read'))::int AS total_delivered,
    count(*) FILTER (WHERE outcome='failed')::int AS total_failed
  FROM line_outcomes WHERE sent_at>=${STATS_FROM} AND sent_at<${STATS_TO} GROUP BY line_id
)`
