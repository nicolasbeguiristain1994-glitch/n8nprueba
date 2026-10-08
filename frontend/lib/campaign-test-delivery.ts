import type { PoolClient } from 'pg'
import { withTransaction } from '@/lib/db'
import type { CampaignTestAttempt } from '@/lib/campaign-test-types'
import type { WebhookStatus } from '@/lib/cloud-api/types/webhooks'

export const CAMPAIGN_TEST_ATTEMPT_COLUMNS = `id, campaign_id, recipient_id, line_id, first_name, phone_number,
  line_name, status, provider_message_id, error, created_at, delivery_error_code, delivery_updated_at`

async function lockReceipt(client: PoolClient, phoneNumberId: string, providerId: string) {
  // Both receipt ingestion and HTTP completion take this lock before row locks.
  // Thus neither side can miss a concurrent receipt or overwrite its newer state.
  await client.query('SELECT pg_advisory_xact_lock(146,hashtext($1))', [JSON.stringify([phoneNumberId, providerId])])
}

async function applyReceipt(client: PoolClient, phoneNumberId: string, providerId: string) {
  await client.query(`UPDATE campaign_test_sends t SET
      status=r.status,error=r.error_detail,delivery_error_code=r.error_code,
      delivery_updated_at=r.occurred_at,updated_at=now()
    FROM campaign_test_delivery_receipts r
    WHERE r.phone_number_id=$1 AND r.provider_message_id=$2
      AND t.phone_number_id=r.phone_number_id AND t.provider_message_id=r.provider_message_id
      AND (array_position(ARRAY['sending','uncertain','sent','failed','delivered','read'],r.status)
          > array_position(ARRAY['sending','uncertain','sent','failed','delivered','read'],t.status)
        OR (r.status=t.status AND (t.delivery_updated_at IS NULL OR r.occurred_at>=t.delivery_updated_at)))
      AND (t.status,t.error,t.delivery_error_code,t.delivery_updated_at)
        IS DISTINCT FROM (r.status,r.error_detail,r.error_code,r.occurred_at)`, [phoneNumberId, providerId])
}

/** Called only after webhook signature, app/WABA and sender checks have passed. */
export async function recordCampaignTestDelivery(phoneNumberId: string, event: WebhookStatus): Promise<void> {
  if (!['sent', 'delivered', 'read', 'failed'].includes(event.status)) return
  if (!event.id || !/^\d{1,12}$/.test(event.timestamp) || !event.recipient_id) throw new Error('Invalid delivery receipt')
  const occurredAt = new Date(Number(event.timestamp) * 1000)
  if (!Number.isFinite(occurredAt.getTime())) throw new Error('Invalid delivery timestamp')
  const recipientPhone = event.recipient_id.replace(/[^0-9]/g, '')
  if (!recipientPhone) throw new Error('Invalid delivery recipient')
  const failure = event.status === 'failed'
  const error = event.errors?.[0]
  const code = failure && Number.isInteger(error?.code) ? error!.code : null
  const detail = failure
    ? `[meta:${code ?? 'unknown'}] ${error?.error_data?.details ?? error?.message ?? error?.title ?? 'Meta informó un fallo de entrega.'}`.slice(0, 2000)
    : null
  await withTransaction(async client => {
    await lockReceipt(client, phoneNumberId, event.id)
    await client.query(`INSERT INTO campaign_test_delivery_receipts
        (phone_number_id,provider_message_id,recipient_phone,status,occurred_at,error_code,error_detail)
      SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS (
        SELECT 1 FROM campaign_test_sends t WHERE t.phone_number_id=$1 AND (
          t.provider_message_id=$2 OR (t.provider_message_id IS NULL AND t.status IN ('sending','uncertain')
            AND t.created_at>now()-interval '2 minutes')))
      ON CONFLICT (phone_number_id,provider_message_id) DO UPDATE SET
        status=EXCLUDED.status,occurred_at=EXCLUDED.occurred_at,error_code=EXCLUDED.error_code,
        error_detail=EXCLUDED.error_detail,updated_at=now()
      WHERE (
        array_position(ARRAY['sent','failed','delivered','read'],EXCLUDED.status)
          > array_position(ARRAY['sent','failed','delivered','read'],campaign_test_delivery_receipts.status)
        OR (EXCLUDED.status=campaign_test_delivery_receipts.status
          AND EXCLUDED.occurred_at>=campaign_test_delivery_receipts.occurred_at))`,
    [phoneNumberId, event.id, recipientPhone, event.status, occurredAt, code, detail])
    await applyReceipt(client, phoneNumberId, event.id)
  })
}

/** Completes the HTTP attempt without replacing any confirmed delivery receipt. */
export async function completeCampaignTestAttempt(
  id: string, phoneNumberId: string, status: 'sent' | 'failed' | 'uncertain',
  providerId: string | null, error: string | null,
): Promise<CampaignTestAttempt> {
  return withTransaction(async client => {
    if (providerId) await lockReceipt(client, phoneNumberId, providerId)
    const updated = await client.query(`UPDATE campaign_test_sends SET
        status=CASE WHEN delivery_updated_at IS NULL AND status IN ('sending','uncertain') THEN $2 ELSE status END,
        error=CASE WHEN delivery_updated_at IS NULL AND status IN ('sending','uncertain') THEN $4 ELSE error END,
        provider_message_id=COALESCE(provider_message_id,$3),updated_at=now()
      WHERE id=$1 AND phone_number_id=$5
        AND (provider_message_id IS NULL OR provider_message_id=$3)
      RETURNING id`, [id, status, providerId, error, phoneNumberId])
    if (!updated.rows[0]) throw new Error('Missing test attempt')
    if (providerId) await applyReceipt(client, phoneNumberId, providerId)
    const result = await client.query<CampaignTestAttempt>(
      `SELECT ${CAMPAIGN_TEST_ATTEMPT_COLUMNS} FROM campaign_test_sends WHERE id=$1`, [id])
    return result.rows[0]
  })
}
