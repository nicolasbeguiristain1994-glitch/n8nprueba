import { readBroadcastRange } from './broadcast-range'

/** Match the recipient's normalized phone, across all sending lines/campaigns.
 * Successful message attempts survive later failed retries. Reservations, tests,
 * manual chats and failed delivery are not evidence of a completed broadcast.
 * Legacy recipients are used only when no provider log exists for that phone in
 * that campaign; otherwise its delivery status is the authoritative evidence.
 * An uncorrelated set lets PostgreSQL hash history once, not per contact.
 */
export function contactBroadcastClause(sp: URLSearchParams, bind: (v: unknown) => string): string | null {
  const range = readBroadcastRange(sp)
  if (!range.mode) return null
  const lower = range.period === 'days'
    ? `CURRENT_TIMESTAMP - (${bind(Number(range.days))}::integer * INTERVAL '24 hours')`
    : `(${bind(range.from)}::date::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')`
  const upper = range.period === 'days' ? 'CURRENT_TIMESTAMP'
    : `((${bind(range.to)}::date + 1)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')`
  const datePredicate = (column: string) => `${column} >= ${lower} AND ${column} ${range.period === 'days' ? '<=' : '<'} ${upper}`
  return `regexp_replace(contacts.phone_number,'[^0-9]','','g') ${range.mode === 'not_sent' ? 'NOT ' : ''}IN (
    SELECT regexp_replace(wm.phone_number,'[^0-9]','','g') FROM whatsapp_messages wm
    WHERE wm.campaign_id IS NOT NULL AND wm.direction='outbound'
      AND wm.status IN ('sent','delivered','read') AND wm.phone_number IS NOT NULL
      AND ${datePredicate('COALESCE(wm.sent_at,wm.created_at)')}
    UNION
    SELECT regexp_replace(cr.phone_number,'[^0-9]','','g') FROM campaign_recipients cr
    WHERE cr.status='sent' AND cr.phone_number IS NOT NULL AND ${datePredicate('cr.sent_at')}
      AND NOT EXISTS (SELECT 1 FROM whatsapp_messages logged
        WHERE logged.campaign_id=cr.campaign_id AND logged.direction='outbound'
          AND regexp_replace(logged.phone_number,'[^0-9]','','g')=regexp_replace(cr.phone_number,'[^0-9]','','g'))
  )`
}
