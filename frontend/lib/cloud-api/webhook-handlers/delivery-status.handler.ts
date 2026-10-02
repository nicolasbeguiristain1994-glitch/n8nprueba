import { query } from '@/lib/db'
// Handler: actualización de estado de entrega (sent/delivered/read/failed).

import { messageRepository }    from '../repositories/conversation.repository'
import { cloudMetrics }         from '../infrastructure/metrics'
import { createLogger }         from '../infrastructure/logger'
import type { WebhookStatus }   from '../types/webhooks'

export async function handleDeliveryStatus(
  phoneNumberId: string,
  status:        WebhookStatus,
  correlationId: string,
): Promise<void> {
  const log = createLogger({ correlationId, phoneNumberId, operation: 'delivery_status' })
  const error = status.errors?.[0]
  const details = error?.error_data?.details ?? error?.message ?? error?.title
  const failureDetail = status.status === 'failed'
    ? `[meta:${error?.code ?? 'unknown'}] ${details ?? 'Meta informó un fallo de entrega.'}`.slice(0,2000)
    : null

  await messageRepository.updateStatus(status.id, status.status, {
    errorCode:       status.errors?.[0]?.code ?? null,
    errorTitle:      status.errors?.[0]?.title ?? null,
    errorDetails:    details ?? null,
    pricingModel:    status.pricing?.pricing_model ?? null,
    pricingCategory: status.pricing?.category ?? null,
    billable:        status.pricing?.billable ?? null,
  })

  // Campaigns and the quick-send screen keep their delivery log in the legacy table.
  if (['sent','delivered','read','failed'].includes(status.status)) await query(`WITH updated AS (UPDATE whatsapp_messages
    SET status=$1::message_status,
        delivered_at=CASE WHEN $1='delivered' THEN COALESCE(delivered_at,NOW()) ELSE delivered_at END,
        read_at=CASE WHEN $1='read' THEN COALESCE(read_at,NOW()) ELSE read_at END,
        failed_at=CASE WHEN $1='failed' THEN COALESCE(failed_at,NOW()) ELSE NULL END,
        error_detail=$3, updated_at=NOW()
    WHERE evolution_message_id=$2 AND direction='outbound'
      AND NOT (status='read' AND $1 IN ('sent','delivered','failed'))
      AND NOT (status='delivered' AND $1 IN ('sent','failed'))
      AND NOT (status='failed' AND $1='sent')
    RETURNING id,campaign_recipient_id,status,error_detail,failed_at), recipients AS (
    UPDATE campaign_recipients cr SET
      status=CASE WHEN u.status='failed' THEN 'failed' ELSE 'sent' END,
      error_detail=u.error_detail,failed_at=u.failed_at,locked_at=NULL,updated_at=NOW()
    FROM updated u WHERE cr.id=u.campaign_recipient_id RETURNING cr.id)
    UPDATE contact_send_history h SET
      frequency_released_at=CASE WHEN u.status='failed' THEN COALESCE(h.frequency_released_at,NOW()) ELSE NULL END,
      failed_message_id=u.id
    FROM updated u WHERE u.status IN ('failed','delivered','read') AND
      (h.campaign_recipient_id=u.campaign_recipient_id OR h.failed_message_id=u.id)`, [status.status,status.id,failureDetail])

  cloudMetrics.deliveryStatus(phoneNumberId, status.status)

  // 131026 means undeliverable; it does not prove that the recipient opted out.

  log.logInfo('status updated', { wamid: status.id, status: status.status })
}
