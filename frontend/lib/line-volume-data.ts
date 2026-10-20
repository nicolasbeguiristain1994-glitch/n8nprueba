import { query } from '@/lib/db'
import { lineVisibilityClause } from '@/lib/line-visibility'
import { LINE_VOLUME_TIME_ZONE, type LineVolumeDay, type LineVolumeInput } from '@/lib/line-volume-policy'

type LineRow = Omit<LineVolumeInput, 'now' | 'recentDays' | 'activeRiskReasons' | 'lastRiskAt'>
type HistoryRow = { id: string; days: LineVolumeDay[]; incomplete: boolean; activeRisk: boolean; lastRiskAt: string | Date | null }

// Results, not a complete audit of HTTP attempts: a legacy retry can overwrite
// its message row. Retry/ambiguous evidence therefore never authorizes growth.
export const LINE_VOLUME_HISTORY_SQL = `
WITH bounds AS (
 SELECT $2::timestamptz AS now,
   (($2::timestamptz AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}')::date - 27)::timestamp
     AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}' AS start_at
), visible AS MATERIALIZED (
 SELECT id,line_type,evolution_instance,status,is_connected,sending_enabled,allowed_types
 FROM whatsapp_lines WHERE id=ANY($1::uuid[])
), numbers AS MATERIALIZED (
 SELECT cn.whatsapp_line_id AS line_id,cn.phone_number_id,cn.waba_id,cn.status
 FROM cloud_numbers cn JOIN visible v ON v.id=cn.whatsapp_line_id
), usage AS MATERIALIZED (
 SELECT u.* FROM line_usage_log u JOIN visible v ON v.id=u.line_id,bounds b
 WHERE u.campaign_id IS NOT NULL AND u.created_at>=b.start_at AND u.created_at<=b.now
), usage_line AS (
 SELECT recipient_id,MIN(line_id::text) AS line_id,COUNT(DISTINCT line_id) AS lines
 FROM usage WHERE recipient_id IS NOT NULL GROUP BY recipient_id
), legacy AS MATERIALIZED (
 SELECT w.id,w.campaign_id,w.campaign_recipient_id AS recipient_id,
   regexp_replace(w.phone_number,'[^0-9]','','g') AS phone,w.created_at,w.failed_at,COALESCE(r.attempts,0) AS attempts,
   COALESCE(NULLIF(w.evolution_message_id,''),NULLIF(w.whatsapp_message_id,''),'legacy:'||w.id) AS key,
   COALESCE(NULLIF(w.metadata->>'line_id',''),r.line_id::text,
     CASE WHEN ul.lines=1 THEN ul.line_id END) AS line_id,
   w.status::text AS status,COALESCE(NULLIF(w.evolution_message_id,''),NULLIF(w.whatsapp_message_id,'')) IS NOT NULL AS provider_id,
   COALESCE(w.error_detail,'') AS error,
   CASE WHEN w.error_detail LIKE '%[meta:131049]%' OR w.error_code='131049' THEN 131049 END AS code,
   CASE WHEN w.status='queued' THEN COALESCE(w.updated_at,w.created_at)
     WHEN w.status='failed' AND COALESCE(NULLIF(w.evolution_message_id,''),NULLIF(w.whatsapp_message_id,'')) IS NULL THEN COALESCE(w.failed_at,w.created_at)
     ELSE COALESCE(w.sent_at,w.created_at) END AS at,
   COALESCE(r.attempts,0)>1 OR COALESCE(ul.lines,0)>1
     OR (r.line_id IS NULL AND NULLIF(w.metadata->>'line_id','') IS NULL)
     OR (NULLIF(w.metadata->>'line_id','') IS NOT NULL AND r.line_id IS NOT NULL AND w.metadata->>'line_id'<>r.line_id::text)
     OR (w.status::text IN ('sent','delivered','read') AND COALESCE(NULLIF(w.evolution_message_id,''),NULLIF(w.whatsapp_message_id,'')) IS NULL) AS incomplete
 FROM whatsapp_messages w LEFT JOIN campaign_recipients r ON r.id=w.campaign_recipient_id
 LEFT JOIN usage_line ul ON ul.recipient_id=w.campaign_recipient_id,bounds b
 WHERE w.campaign_id IS NOT NULL AND w.direction='outbound'
   AND (w.created_at>=b.start_at OR w.sent_at>=b.start_at OR w.failed_at>=b.start_at OR w.updated_at>=b.start_at)
   AND COALESCE(w.metadata->>'source','') NOT IN ('campaign_risk_alert','opt_out_confirmation','automation')
), raw AS MATERIALIZED (
 SELECT l.key,v.id AS line_id,l.recipient_id,l.status,l.provider_id,l.error,l.code,l.at,l.incomplete,
   'legacy'::text AS source,l.campaign_id,l.phone,l.created_at AS started_at,l.failed_at,l.attempts
 FROM legacy l JOIN visible v ON v.id::text=l.line_id,bounds b
 WHERE l.at>=b.start_at AND l.at<=b.now
 UNION ALL
 SELECT COALESCE(NULLIF(m.wamid,''),'cloud:'||m.id),n.line_id,NULL::uuid,m.status,NULLIF(m.wamid,'') IS NOT NULL,
   COALESCE(m.error_title,'')||' '||COALESCE(m.error_details,''),m.error_code,
   CASE WHEN m.status='queued' THEN COALESCE(m.queued_at,m.created_at)
     WHEN m.status='failed' AND NULLIF(m.wamid,'') IS NULL THEN COALESCE(m.failed_at,m.created_at)
     ELSE COALESCE(m.sent_at,m.created_at) END,
   m.status IN ('sent','delivered','read') AND NULLIF(m.wamid,'') IS NULL,
   'cloud',m.campaign_id,regexp_replace(COALESCE(NULLIF(m.content->>'to',''),cv.contact_phone,''),'[^0-9]','','g'),
   COALESCE(m.queued_at,m.created_at),m.failed_at,NULL::int
 FROM cloud_messages m JOIN numbers n ON n.phone_number_id=m.phone_number_id
 LEFT JOIN cloud_conversations cv ON cv.id=m.conversation_id,bounds b
 WHERE m.campaign_id IS NOT NULL AND m.direction='outbound' AND NOT COALESCE(m.is_historical,false)
   AND (m.created_at>=b.start_at OR m.sent_at>=b.start_at OR m.failed_at>=b.start_at)
   AND COALESCE(m.content->>'source','') NOT IN ('campaign_risk_alert','opt_out_confirmation','automation')
), actual AS MATERIALIZED (
 SELECT r.* FROM raw r,bounds b WHERE r.at>=b.start_at AND r.at<=b.now
   AND r.status IN ('queued','sent','delivered','read','failed')
   AND r.error NOT LIKE '%no-send%'
   AND r.error NOT LIKE '%pre-send-persistence-error%'
   AND r.error NOT LIKE '%line-unavailable-before-send%'
   AND r.error NOT LIKE '%[global-opt-out]%'
   AND r.error NOT LIKE '%agent-opt-out%'
), queued_failure_candidates AS (
 -- Some historical producers left a Cloud queue mirror when the legacy row
 -- recorded a synchronous rejection. Correlate only a unique first attempt,
 -- with the same campaign/contact/line and a tightly bounded lifecycle.
 -- Never merge a queue with an accepted send or infer a successful outcome.
 SELECT q.key AS queued_key,f.key AS failed_key,q.line_id,
   COUNT(*) OVER(PARTITION BY q.key,q.line_id) AS queue_matches,
   COUNT(*) OVER(PARTITION BY f.key,f.line_id) AS failure_matches
 FROM actual q JOIN actual f ON f.source='legacy' AND f.status='failed' AND NOT f.provider_id
   AND f.attempts=1 AND f.error LIKE '[meta:%]%'
   AND f.campaign_id=q.campaign_id AND f.line_id=q.line_id AND f.phone=q.phone AND f.phone<>''
   AND q.started_at BETWEEN f.started_at AND f.failed_at
   AND f.failed_at-f.started_at BETWEEN interval '0 seconds' AND interval '30 seconds'
 WHERE q.source='cloud' AND q.status='queued' AND NOT q.provider_id
), queued_failure_mirrors AS (
 SELECT queued_key,failed_key,line_id FROM queued_failure_candidates WHERE queue_matches=1 AND failure_matches=1
), conflicting_lines AS (
 SELECT key FROM actual GROUP BY key HAVING COUNT(DISTINCT line_id)>1
), dedup AS MATERIALIZED (
 SELECT key,line_id,MIN(at) AS at,
   BOOL_OR(provider_id OR status IN ('sent','delivered','read')) AS accepted,
   BOOL_OR(status IN ('delivered','read')) AS delivered,
   BOOL_OR(status='failed' AND error NOT LIKE '%outcome-unknown%' AND error NOT LIKE '%stale-queued%') AS failed,
   BOOL_OR(code=131049 AND status='failed') AS ecosystem,
   BOOL_OR(status='queued' OR error LIKE '%outcome-unknown%' OR error LIKE '%stale-queued%') AS unknown,
   BOOL_OR(incomplete) OR key IN (SELECT key FROM conflicting_lines)
     OR key IN (SELECT failed_key FROM queued_failure_mirrors) AS incomplete
 FROM actual a WHERE NOT EXISTS(SELECT 1 FROM queued_failure_mirrors m WHERE m.queued_key=a.key AND m.line_id=a.line_id)
 GROUP BY key,line_id
), daily AS (
 SELECT line_id,(at AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}')::date AS day,
   COUNT(*)::int AS attempted,COUNT(*) FILTER(WHERE accepted)::int AS accepted,
   COUNT(*) FILTER(WHERE delivered)::int AS delivered,
   COUNT(*) FILTER(WHERE failed AND NOT delivered)::int AS failed,
   COUNT(*) FILTER(WHERE ecosystem AND NOT delivered)::int AS ecosystem,
   COUNT(*) FILTER(WHERE unknown AND NOT accepted AND NOT delivered)::int AS unknown,
   MAX(at) FILTER(WHERE accepted) AS last_sent_at,BOOL_OR(incomplete OR unknown) AS incomplete
 FROM dedup GROUP BY line_id,day
), extra_failures AS (
 -- Preserve a failed attempt that a later retry erased. A current failed row
 -- already represents that recipient/day, so do not count its log again.
 SELECT u.line_id,(u.created_at AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}')::date AS day,
   COUNT(DISTINCT COALESCE(u.recipient_id::text,u.id::text))::int AS failed,
   COUNT(DISTINCT COALESCE(u.recipient_id::text,u.id::text)) FILTER(
     WHERE u.error_code='131049' OR u.error_message LIKE '%[meta:131049]%')::int AS ecosystem
 FROM usage u WHERE u.status='failed'
   AND COALESCE(u.error_message,'') NOT LIKE '%no-send%'
   AND COALESCE(u.error_message,'') NOT LIKE '%outcome-unknown%'
   AND NOT EXISTS(SELECT 1 FROM actual a WHERE a.line_id=u.line_id AND a.recipient_id=u.recipient_id
     AND a.status='failed' AND (a.at AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}')::date=
       (u.created_at AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}')::date)
 GROUP BY u.line_id,day
), optouts AS (
 SELECT v.id AS line_id,(l.created_at AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}')::date AS day,
   COUNT(DISTINCT regexp_replace(l.contact_phone,'[^0-9]','','g'))::int AS optouts
 FROM cloud_consent_log l JOIN visible v ON
   (v.line_type='evolution' AND l.phone_number_id='evolution:'||v.evolution_instance)
   OR EXISTS(SELECT 1 FROM numbers n WHERE n.line_id=v.id AND n.phone_number_id=l.phone_number_id),bounds b
 WHERE l.event='opt_out' AND l.created_at>=b.start_at AND l.created_at<=b.now
 GROUP BY v.id,day
), candidate_campaigns AS (
 -- Match the core guard's candidate pool before recipients have a line. The
 -- owner's visibility, not the viewer's role, determines whether a line can
 -- participate in that campaign. No campaign identity leaves this query.
 SELECT DISTINCT v.id AS line_id,c.id AS campaign_id
 FROM visible v JOIN numbers n ON n.line_id=v.id JOIN campaigns c ON
   c.status IN ('draft','scheduled','running','paused') AND (c.message_type='template' OR c.use_multi_line=true)
 WHERE v.line_type='cloud' AND v.status='active' AND v.is_connected AND v.sending_enabled AND n.status='active'
   AND (v.allowed_types IS NULL OR v.allowed_types @> '["campaign"]'::jsonb)
   AND (c.owned_by IS NULL OR v.id IN (SELECT id FROM get_accessible_line_ids(c.owned_by) AS owner_lines(id)))
   AND (c.message_type IS DISTINCT FROM 'template' OR EXISTS(SELECT 1 FROM whatsapp_templates wt
     WHERE wt.id=c.template_id AND wt.waba_id=n.waba_id))
), risk_rows AS (
 SELECT n.line_id,true AS active,NULL::timestamptz AS risk_at
 FROM numbers n JOIN campaign_risk_signals s ON s.signal_active AND
   ((s.scope_type='phone' AND s.scope_id=n.phone_number_id) OR (s.scope_type='waba' AND s.scope_id=n.waba_id))
 UNION ALL
 SELECT v.id,i.resolved_at IS NULL,COALESCE(i.resolved_at,i.last_observed_at,i.detected_at)
 FROM visible v JOIN campaign_risk_incidents i ON
   EXISTS(SELECT 1 FROM campaign_recipients r WHERE r.campaign_id=i.campaign_id AND r.line_id=v.id)
   OR EXISTS(SELECT 1 FROM candidate_campaigns cc WHERE cc.campaign_id=i.campaign_id AND cc.line_id=v.id)
   OR EXISTS(SELECT 1 FROM numbers n WHERE n.line_id=v.id AND
     ((i.scope_type='phone' AND i.scope_id=n.phone_number_id) OR (i.scope_type='waba' AND i.scope_id=n.waba_id)))
), risks AS (
 SELECT line_id,BOOL_OR(active) AS active,MAX(risk_at) AS last_risk_at FROM risk_rows GROUP BY line_id
), dates AS (
 SELECT generate_series((b.start_at AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}')::date,
   (b.now AT TIME ZONE '${LINE_VOLUME_TIME_ZONE}')::date,interval '1 day')::date AS day FROM bounds b
)
SELECT v.id,
 JSONB_AGG(JSONB_BUILD_OBJECT('date',dates.day::text,
   'attempted',COALESCE(d.attempted,0)+COALESCE(f.failed,0),'accepted',COALESCE(d.accepted,0),
   'delivered',COALESCE(d.delivered,0),'failed',COALESCE(d.failed,0)+COALESCE(f.failed,0),
   'ecosystemRejected',COALESCE(d.ecosystem,0)+COALESCE(f.ecosystem,0),'unknown',COALESCE(d.unknown,0),
   'optOuts',COALESCE(o.optouts,0),'lastSentAt',d.last_sent_at) ORDER BY dates.day) AS days,
 BOOL_OR(COALESCE(d.incomplete,false) OR COALESCE(f.failed,0)>0) AS incomplete,
 COALESCE(BOOL_OR(r.active),false) AS "activeRisk",MAX(r.last_risk_at) AS "lastRiskAt"
FROM visible v CROSS JOIN dates
LEFT JOIN daily d ON d.line_id=v.id AND d.day=dates.day
LEFT JOIN extra_failures f ON f.line_id=v.id AND f.day=dates.day
LEFT JOIN optouts o ON o.line_id=v.id AND o.day=dates.day
LEFT JOIN risks r ON r.line_id=v.id
GROUP BY v.id ORDER BY v.id`

/** Read-only: no quota reset, Meta request, notification or campaign mutation. */
export async function getLineVolumeInputs(accessibleLineIds: string[] | null, now = new Date()): Promise<LineVolumeInput[]> {
  if (accessibleLineIds?.length === 0) return []
  const asOf = now.toISOString()
  const scope = lineVisibilityClause(accessibleLineIds, 'l', 2)
  const lines = await query<LineRow>(`SELECT l.id,l.line_type AS "lineType",l.status,
    l.is_connected AS "isConnected",l.sending_enabled AS "sendingEnabled",
    (l.allowed_types IS NULL OR l.allowed_types @> '["campaign"]'::jsonb) AS "campaignsAllowed",
    l.msg_per_day AS "dailyLimit",l.msg_per_hour AS "hourlyLimit",
    CASE WHEN l.day_reset_at<=$1::timestamptz THEN 0 ELSE l.msgs_sent_today END AS "dailyUsed",
    CASE WHEN l.hour_reset_at<=$1::timestamptz THEN 0 ELSE l.msgs_sent_hour END AS "hourlyUsed",
    cn.status AS "cloudStatus",cn.quality AS quality,cn.checked_at AS "lastMetaCheckAt",
    COALESCE(cn.connections,0)>1 AS "evidenceIncomplete"
    FROM whatsapp_lines l LEFT JOIN LATERAL (
      SELECT CASE WHEN COUNT(*)=0 THEN NULL WHEN BOOL_AND(status='active') THEN 'active' ELSE 'inactive' END AS status,
        CASE WHEN COUNT(*)=0 THEN NULL WHEN BOOL_OR(quality_rating='RED') THEN 'RED' WHEN BOOL_OR(quality_rating='YELLOW') THEN 'YELLOW'
          WHEN BOOL_AND(quality_rating='GREEN') AND COUNT(quality_rating)=COUNT(*) THEN 'GREEN' ELSE 'UNKNOWN' END AS quality,
        CASE WHEN COUNT(risk_checked_at)=COUNT(*) THEN MIN(risk_checked_at) END AS checked_at,COUNT(*) AS connections
      FROM cloud_numbers WHERE whatsapp_line_id=l.id
    ) cn ON true WHERE 1=1 ${scope.clause} ORDER BY l.id`, [asOf,...scope.params])
  if (!lines.length) return []
  const history = await query<HistoryRow>(LINE_VOLUME_HISTORY_SQL, [lines.map(l => l.id),asOf])
  const byId = new Map(history.map(row => [row.id,row]))
  return lines.map(line => {
    const row = byId.get(line.id)
    // Missing history must not be mistaken for a healthy, unused line.
    if (!row) throw new Error('LINE_VOLUME_HISTORY_INCOMPLETE')
    return { ...line, now: asOf, lastMetaCheckAt: line.lastMetaCheckAt ? new Date(line.lastMetaCheckAt).toISOString() : null,
      recentDays: row.days.map(day => ({ ...day,lastSentAt: day.lastSentAt ? new Date(day.lastSentAt).toISOString() : null })),
      evidenceIncomplete: line.evidenceIncomplete || row.incomplete,
      activeRiskReasons: row.activeRisk ? ['Hay una alerta de riesgo pendiente asociada a esta línea. Revisala antes de iniciar nuevas campañas.'] : [],
      lastRiskAt: row.lastRiskAt ? new Date(row.lastRiskAt).toISOString() : null }
  })
}
