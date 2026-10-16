import { broadcastMessageAgentSql,broadcastRecipientAgentSql } from './broadcast-agent'
/** Same successful-send evidence as the Difusión filter. Query only the visible
 * phones, across campaigns and sending lines; frequency reservations are not sends.
 */
export const LAST_CONTACT_BROADCAST_SQL = `
  WITH history AS (
    SELECT regexp_replace(wm.phone_number,'[^0-9]','','g') AS phone,${broadcastMessageAgentSql()} AS agent,
      COALESCE(wm.sent_at,wm.created_at) AS sent_at
    FROM whatsapp_messages wm
    WHERE wm.campaign_id IS NOT NULL AND wm.direction='outbound'
      AND wm.status IN ('sent','delivered','read')
      AND regexp_replace(wm.phone_number,'[^0-9]','','g') = ANY($1::text[])
      AND COALESCE(wm.sent_at,wm.created_at) <= CURRENT_TIMESTAMP
    UNION ALL
    SELECT regexp_replace(cr.phone_number,'[^0-9]','','g') AS phone,${broadcastRecipientAgentSql()} AS agent, cr.sent_at
    FROM campaign_recipients cr
    WHERE cr.status='sent'
      AND regexp_replace(cr.phone_number,'[^0-9]','','g') = ANY($1::text[])
      AND cr.sent_at <= CURRENT_TIMESTAMP
      AND NOT EXISTS (SELECT 1 FROM whatsapp_messages logged
        WHERE logged.campaign_id=cr.campaign_id AND logged.direction='outbound'
          AND regexp_replace(logged.phone_number,'[^0-9]','','g')=regexp_replace(cr.phone_number,'[^0-9]','','g'))
  )
  SELECT phone,agent, MAX(sent_at) AS last_broadcast_at,
    FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MAX(sent_at))) / 86400)::int AS days_since_last_broadcast
  FROM history GROUP BY phone,agent
`

interface BroadcastHistoryRow {
  phone: string
  agent?: string
  last_broadcast_at: Date | string
  days_since_last_broadcast: number
}
export interface LastContactBroadcast { lastBroadcastAt: string; daysSinceLastBroadcast: number }
type ReadQuery = <T>(sql: string, params?: unknown[]) => Promise<T[]>
export const broadcastPhone = (phone: string | null | undefined) => (phone || '').replace(/[^0-9]/g, '')

export const broadcastAccountKey = (phone:string,agent:unknown) => `${broadcastPhone(phone)}:${typeof agent==='string'?agent:''}`
export async function getLastContactBroadcasts(phones: (string|{phone_number:string;panel?:unknown})[], read: ReadQuery): Promise<Map<string, LastContactBroadcast>> {
  const normalized = [...new Set(phones.map(p=>broadcastPhone(typeof p==='string'?p:p.phone_number)).filter(Boolean))]
  if (!normalized.length) return new Map()
  const rows = await read<BroadcastHistoryRow>(LAST_CONTACT_BROADCAST_SQL, [normalized])
  const scoped=typeof phones[0]!=='string'
  return new Map(rows.map(row => [scoped?broadcastAccountKey(row.phone,row.agent):row.phone, {
    lastBroadcastAt: new Date(row.last_broadcast_at).toISOString(),
    daysSinceLastBroadcast: Number(row.days_since_last_broadcast),
  }]))
}
