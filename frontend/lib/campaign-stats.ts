export const CAMPAIGN_OUTCOME_SQL = `CASE
     WHEN m.status IN ('delivered','read') THEN m.status::text
     WHEN cr.status = 'skipped' THEN 'skipped'
     WHEN cr.status IN ('pending','sending') AND (m.status IS NULL OR m.status IN ('queued','failed')) THEN cr.status
     WHEN cr.status = 'failed' OR m.status = 'failed' THEN 'failed'
     WHEN m.status IN ('sent','delivered','read') THEN m.status::text
     ELSE cr.status END`

// One outcome per snapshotted recipient, using the latest provider log. In
// particular, a skipped recipient is not also a failure, and accepted != delivered.
export const CAMPAIGN_STATS_SQL = `
 SELECT COUNT(*) FILTER (WHERE outcome IN ('sent','delivered','read'))::int AS sent,
        COUNT(*) FILTER (WHERE outcome IN ('delivered','read'))::int AS delivered,
        COUNT(*) FILTER (WHERE outcome = 'read')::int AS read,
        COUNT(*) FILTER (WHERE outcome = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE outcome = 'skipped')::int AS skipped
 FROM (
   SELECT ${CAMPAIGN_OUTCOME_SQL} AS outcome
   FROM campaign_recipients cr
   LEFT JOIN (
     SELECT DISTINCT ON (regexp_replace(wm.phone_number,'[^0-9]','','g'))
       regexp_replace(wm.phone_number,'[^0-9]','','g') AS phone, wm.status
     FROM whatsapp_messages wm
     WHERE wm.campaign_id=c.id AND wm.direction='outbound'
     ORDER BY regexp_replace(wm.phone_number,'[^0-9]','','g'), wm.created_at DESC, wm.id DESC
   ) m ON m.phone=regexp_replace(cr.phone_number,'[^0-9]','','g')
   WHERE cr.campaign_id=c.id
 ) outcomes`
