import { query } from '@/lib/db'
import { argentinaToday, shiftDate, validDateRange } from '@/lib/dashboard-format'
import { CAMPAIGN_STATS_SQL } from '@/lib/campaign-stats'
import { CAMPAIGN_REPLIES_SQL } from '@/lib/campaign-replies'

export const STATS_TIMEZONE = 'America/Argentina/Buenos_Aires'
export function statisticsRange(params: URLSearchParams) {
  const to = params.get('to') || argentinaToday()
  const from = params.get('from') || shiftDate(argentinaToday(), -29)
  return validDateRange(from, to) ? { from, to } : null
}
// A range includes both calendar days in the operating timezone, not server UTC.
export const STATS_FROM = "($1::date::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')"
export const STATS_TO = "(($2::date + 1)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')"
export const STATS_DAY = "(wm.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date"

export async function campaignStatistics(from: string, to: string, owner: string | null, status = '', search = '') {
  return query<Record<string, unknown>>(`
    SELECT c.id,c.name,c.type,c.status,c.created_at,c.completed_at,
      stats.sent AS enviados,stats.delivered AS entregados,stats.read AS leidos,
      stats.failed AS fallidos,stats.skipped AS omitidos,
      (SELECT count(*)::int FROM (${CAMPAIGN_REPLIES_SQL}) replies) AS respuestas,
      round(100.0*stats.delivered/NULLIF(stats.sent,0),1) AS tasa_entrega,
      round(100.0*stats.read/NULLIF(stats.sent,0),1) AS tasa_lectura
    FROM campaigns c CROSS JOIN LATERAL (${CAMPAIGN_STATS_SQL}) stats
    WHERE c.created_at >= ${STATS_FROM} AND c.created_at < ${STATS_TO}
      AND ($3::uuid IS NULL OR c.owned_by=$3)
      AND ($4::text='' OR c.status::text=$4) AND ($5::text='' OR c.name ILIKE $6)
    ORDER BY stats.sent DESC,c.created_at DESC LIMIT 100`, [from,to,owner,status,search,`%${search}%`])
}

// Activity metrics count each successful manual message and the latest attempt
// per campaign recipient. A retry supersedes its earlier failure. Visibility is
// enforced before aggregation; parameters: from, to, owner (null = admin).
export const ACTIVITY_CTE = `WITH stats_messages AS (
  SELECT id,campaign_id,template_id,phone_number,direction::text,status::text,created_at FROM whatsapp_messages
  UNION ALL
  SELECT cm.id,cm.campaign_id,t.id,cc.contact_phone,
    CASE WHEN cm.direction='inbound' THEN 'inbound' ELSE 'outbound' END,cm.status,
    COALESCE(cm.sent_at,cm.created_at)
  FROM cloud_messages cm JOIN cloud_conversations cc ON cc.id=cm.conversation_id
  JOIN cloud_numbers cn ON cn.phone_number_id=cm.phone_number_id
  LEFT JOIN LATERAL (SELECT id FROM whatsapp_templates WHERE name=COALESCE(cm.template_name,cm.content #>> '{template,name}') AND waba_id=cn.waba_id ORDER BY created_at DESC LIMIT 1) t ON true
  WHERE NOT EXISTS (SELECT 1 FROM whatsapp_messages legacy WHERE cm.wamid IS NOT NULL AND (legacy.evolution_message_id=cm.wamid OR legacy.whatsapp_message_id=cm.wamid))
), ranked_messages AS (
  SELECT wm.*, row_number() OVER (
    PARTITION BY CASE WHEN wm.direction='outbound' AND wm.campaign_id IS NOT NULL
      THEN wm.campaign_id::text || ':' || regexp_replace(wm.phone_number,'[^0-9]','','g')
      ELSE wm.id::text END
    ORDER BY wm.created_at DESC,wm.id DESC) AS attempt_rank
  FROM stats_messages wm
  WHERE wm.created_at < ${STATS_TO}
    AND ($3::uuid IS NULL OR
      (wm.campaign_id IS NOT NULL AND EXISTS (SELECT 1 FROM campaigns c WHERE c.id=wm.campaign_id AND c.owned_by=$3)) OR
      (wm.campaign_id IS NULL AND EXISTS (SELECT 1 FROM contacts c JOIN operator_contact_visibility v ON v.contact_id=c.id WHERE v.operator_id=$3 AND regexp_replace(c.phone_number,'[^0-9]','','g')=regexp_replace(wm.phone_number,'[^0-9]','','g'))))
), activity AS (
  SELECT * FROM ranked_messages WHERE attempt_rank=1 AND created_at >= ${STATS_FROM}
)`
export const ACTIVITY_METRICS = `
  COUNT(*) FILTER (WHERE direction='outbound' AND status IN ('sent','delivered','read'))::int AS enviados,
  COUNT(*) FILTER (WHERE direction='outbound' AND status IN ('delivered','read'))::int AS entregados,
  COUNT(*) FILTER (WHERE direction='outbound' AND status='read')::int AS leidos,
  COUNT(*) FILTER (WHERE direction='outbound' AND status='failed')::int AS fallidos,
  COUNT(*) FILTER (WHERE direction='inbound')::int AS respuestas`
export async function statisticsSeries(from: string, to: string, owner: string | null) {
  return query<Record<string, unknown>>(`${ACTIVITY_CTE} SELECT ${STATS_DAY}::text AS dia,${ACTIVITY_METRICS}
    FROM activity wm GROUP BY ${STATS_DAY} ORDER BY dia`,[from,to,owner])
}
export function csvCell(value: unknown): string {
  let text=String(value ?? '')
  if (/^[\s]*[=+@-]/.test(text)) text="'"+text
  return '"'+text.replace(/"/g,'""')+'"'
}
