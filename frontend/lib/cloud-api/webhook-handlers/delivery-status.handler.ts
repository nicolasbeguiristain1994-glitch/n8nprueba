// Handler: actualización de estado de entrega (sent/delivered/read/failed).

import { messageRepository }    from '../repositories/conversation.repository'
import { complianceRepository } from '../repositories/compliance.repository'
import { cloudMetrics }         from '../infrastructure/metrics'
import { createLogger }         from '../infrastructure/logger'
import type { WebhookStatus }   from '../types/webhooks'

export async function handleDeliveryStatus(
  phoneNumberId: string,
  status:        WebhookStatus,
  correlationId: string,
): Promise<void> {
  const log = createLogger({ correlationId, phoneNumberId, operation: 'delivery_status' })

  await messageRepository.updateStatus(status.id, status.status, {
    errorCode:       status.errors?.[0]?.code ?? null,
    errorTitle:      status.errors?.[0]?.title ?? null,
    errorDetails:    status.errors?.[0]?.message ?? null,
    pricingModel:    status.pricing?.pricing_model ?? null,
    pricingCategory: status.pricing?.category ?? null,
    billable:        status.pricing?.billable ?? null,
  })

  cloudMetrics.deliveryStatus(phoneNumberId, status.status)

  // Meta notifica opt-out vía error code 131026 en el status de fallo
  if (status.status === 'failed' && status.errors?.some(e => e.code === 131026)) {
    const phone = `+${status.recipient_id}`
    await complianceRepository.recordOptOut({
      phone, phoneNumberId,
      reason: 'policy_violation',
      metadata: { wamid: status.id, errorCode: 131026 },
    })
    cloudMetrics.optOut(phoneNumberId, 'meta_policy')
    log.logWarn('opt_out via 131026', { wamid: status.id })
  }

  log.logInfo('status updated', { wamid: status.id, status: status.status })
}
