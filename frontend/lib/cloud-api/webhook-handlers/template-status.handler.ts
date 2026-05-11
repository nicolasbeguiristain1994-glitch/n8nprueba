// Handler: actualizaciones de estado de plantillas (APPROVED/REJECTED/DISABLED/PAUSED).

import { templateRepository } from '../repositories/template.repository'
import { cloudMetrics }       from '../infrastructure/metrics'
import { createLogger }       from '../infrastructure/logger'
import type { WebhookTemplateStatusUpdate } from '../types/webhooks'

const STATUS_MAP: Record<WebhookTemplateStatusUpdate['event'], string> = {
  APPROVED: 'APROBADA',
  REJECTED: 'RECHAZADA',
  DISABLED: 'DESHABILITADA',
  PAUSED:   'DESHABILITADA',
}

export async function handleTemplateStatusUpdate(
  update:        WebhookTemplateStatusUpdate,
  correlationId: string,
): Promise<void> {
  const log = createLogger({ correlationId, operation: 'template_status_update' })
  const internalStatus = STATUS_MAP[update.event] ?? 'EN_REVISION'

  await templateRepository.updateTemplateStatus(
    update.message_template_id,
    internalStatus,
    update.reason ?? null,
  ).catch(err => log.logWarn('db update failed', { error: String(err) }))

  cloudMetrics.templateStatusUpdated(update.message_template_name, update.event)

  const level = update.event === 'REJECTED' ? 'logWarn' : 'logInfo'
  log[level]('status updated', {
    name:   update.message_template_name,
    lang:   update.message_template_language,
    event:  update.event,
    reason: update.reason ?? null,
  })
}
