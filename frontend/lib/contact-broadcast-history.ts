/** Same successful-send evidence as the Difusión filter. Query only the visible
 * phones, across campaigns and sending lines; frequency reservations are not sends.
 */
export const LAST_CONTACT_BROADCAST_SQL = `
  WITH history AS (
    SELECT regexp_replace(wm.phone_number,'[^0-9]','','g') AS phone,
      COALESCE(wm.sent_at,wm.created_at) AS sent_at
    FROM whatsapp_messages wm
    WHERE wm.campaign_id IS NOT NULL AND wm.direction='outbound'
      AND wm.status IN ('sent','delivered','read')
      AND regexp_replace(wm.phone_number,'[^0-9]','','g') = ANY($1::text[])
      AND COALESCE(wm.sent_at,wm.created_at) <= CURRENT_TIMESTAMP
    UNION ALL
    SELECT regexp_replace(cr.phone_number,'[^0-9]','','g') AS phone, cr.sent_at
    FROM campaign_recipients cr
    WHERE cr.status='sent'
      AND regexp_replace(cr.phone_number,'[^0-9]','','g') = ANY($1::text[])
      AND cr.sent_at <= CURRENT_TIMESTAMP
      AND NOT EXISTS (SELECT 1 FROM whatsapp_messages logged
        WHERE logged.campaign_id=cr.campaign_id AND logged.direction='outbound'
          AND regexp_replace(logged.phone_number,'[^0-9]','','g')=regexp_replace(cr.phone_number,'[^0-9]','','g'))
  )
  SELECT phone, MAX(sent_at) AS last_broadcast_at,
    FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MAX(sent_at))) / 86400)::int AS days_since_last_broadcast
  FROM history GROUP BY phone
`

interface BroadcastHistoryRow {
  phone: string
  last_broadcast_at: Date | string
  days_since_last_broadcast: number
}
export interface LastContactBroadcast { lastBroadcastAt: string; daysSinceLastBroadcast: number }
type ReadQuery = <T>(sql: string, params?: unknown[]) => Promise<T[]>
export const broadcastPhone = (phone: string | null | undefined) => (phone || '').replace(/[^0-9]/g, '')

export async function getLastContactBroadcasts(phones: string[], read: ReadQuery): Promise<Map<string, LastContactBroadcast>> {
  const normalized = [...new Set(phones.map(broadcastPhone).filter(Boolean))]
  if (!normalized.length) return new Map()
  const rows = await read<BroadcastHistoryRow>(LAST_CONTACT_BROADCAST_SQL, [normalized])
  return new Map(rows.map(row => [row.phone, {
    lastBroadcastAt: new Date(row.last_broadcast_at).toISOString(),
    daysSinceLastBroadcast: Number(row.days_since_last_broadcast),
  }]))
}
