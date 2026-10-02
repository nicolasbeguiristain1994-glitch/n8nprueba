import type { PoolClient } from 'pg'

// Trusted, internal SQL fragments only. A provider ID does not mean delivery;
// queued/unknown outcomes must remain fenced even when a UI labels them failed.
export const CONFIRMED_MESSAGE_FAILURE_SQL = `wm.direction='outbound' AND wm.status='failed'
  AND COALESCE(wm.error_detail,'') NOT LIKE '[provider-outcome-unknown-no-resend]%'
  AND COALESCE(wm.error_detail,'') NOT LIKE 'stale-queued-no-resend%'`

// Alias h is contact_send_history. The timestamp guard prevents an old failure
// from releasing a newly reserved slot before its queued message is persisted.
export const FAILED_RESERVATION_SQL = `EXISTS (
  SELECT 1 FROM whatsapp_messages wm
  WHERE wm.campaign_recipient_id=h.campaign_recipient_id
    AND ${CONFIRMED_MESSAGE_FAILURE_SQL}
    AND wm.updated_at >= h.sent_at
    AND NOT EXISTS (SELECT 1 FROM campaign_recipients cr
      WHERE cr.id=h.campaign_recipient_id AND (
        COALESCE(cr.error_detail,'') LIKE '[provider-outcome-unknown-no-resend]%'
        OR COALESCE(cr.error_detail,'') LIKE 'stale-queued-no-resend%'))
)`

export const RETRY_CANDIDATES_SQL = `SELECT cr.id FROM campaign_recipients cr
  WHERE cr.campaign_id=$1 AND cr.locked_at IS NULL
    AND COALESCE(cr.error_detail,'') NOT LIKE '[provider-outcome-unknown-no-resend]%'
    AND COALESCE(cr.error_detail,'') NOT LIKE 'stale-queued-no-resend%'
    AND (
      (cr.status='failed' AND (
        cr.evolution_message_id IS NULL OR EXISTS (
          SELECT 1 FROM whatsapp_messages wm
          WHERE wm.campaign_recipient_id=cr.id
            AND wm.evolution_message_id=cr.evolution_message_id
            AND ${CONFIRMED_MESSAGE_FAILURE_SQL}
        )))
      OR (cr.status='skipped' AND cr.evolution_message_id IS NULL
        AND cr.error_detail LIKE '[freq-blocked]%'
        AND NOT EXISTS (SELECT 1 FROM whatsapp_messages wm WHERE wm.campaign_recipient_id=cr.id)
        AND NOT EXISTS (SELECT 1 FROM contact_send_history h WHERE h.campaign_recipient_id=cr.id))
    )
    AND NOT EXISTS (SELECT 1 FROM whatsapp_messages wm
      WHERE wm.campaign_recipient_id=cr.id AND NOT (${CONFIRMED_MESSAGE_FAILURE_SQL}))
  ORDER BY cr.id FOR UPDATE OF cr`

// Caller holds the campaign row lock and has checked status/ownership.
export async function prepareCampaignRetry(client: PoolClient, campaignId: string): Promise<number> {
  // Match the webhook lock order: messages before recipients.
  await client.query(`SELECT id FROM whatsapp_messages WHERE campaign_id=$1
    AND campaign_recipient_id IS NOT NULL ORDER BY id FOR UPDATE`, [campaignId])
  const { rows } = await client.query<{ id: string }>(RETRY_CANDIDATES_SQL, [campaignId])
  if (!rows.length) return 0
  const ids = rows.map(row => row.id)
  await client.query(`UPDATE contact_send_history h SET
    original_campaign_recipient_id=h.campaign_recipient_id,
    frequency_released_at=COALESCE(h.frequency_released_at,NOW()),
    failed_message_id=(SELECT wm.id FROM whatsapp_messages wm
      WHERE wm.campaign_recipient_id=h.campaign_recipient_id AND ${CONFIRMED_MESSAGE_FAILURE_SQL} LIMIT 1),
    campaign_recipient_id=NULL
    WHERE h.campaign_recipient_id=ANY($1::uuid[])`, [ids])
  await client.query(`UPDATE whatsapp_messages SET original_campaign_recipient_id=campaign_recipient_id,
    campaign_recipient_id=NULL WHERE campaign_recipient_id=ANY($1::uuid[]) AND status='failed'`, [ids])
  await client.query(`UPDATE campaign_recipients SET status='pending', locked_at=NULL, line_id=NULL,
    evolution_message_id=NULL, sent_at=NULL, error_detail=NULL, failed_at=NULL, attempts=0, updated_at=NOW()
    WHERE id=ANY($1::uuid[])`, [ids])
  return ids.length
}
