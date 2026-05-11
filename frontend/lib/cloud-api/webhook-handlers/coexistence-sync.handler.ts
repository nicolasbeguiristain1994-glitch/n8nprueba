// Handler: webhooks de sincronización de Coexistence (history + smb_app_state_sync).

import { cloudNumberRepository } from '../repositories/cloud-number.repository'
import { cloudMetrics }          from '../infrastructure/metrics'
import { createLogger }          from '../infrastructure/logger'
import type { WebhookSyncEvent } from '../types/webhooks'
import type { SmbSyncType }      from '../types/domain'

export async function handleCoexistenceSyncEvent(
  phoneNumberId: string,
  syncType:      SmbSyncType,
  event:         WebhookSyncEvent,
  correlationId: string,
): Promise<void> {
  const log    = createLogger({ correlationId, phoneNumberId, operation: 'coexistence_sync' })
  const failed = event.event === 'error'
  const type   = syncType === 'smb_app_state_sync' ? 'contacts' : 'history'

  if (!failed) {
    await cloudNumberRepository.markSyncComplete(phoneNumberId, type)
    cloudMetrics.syncCompleted(phoneNumberId, syncType)
    log.logInfo('sync completed', { syncType })
  } else {
    await cloudNumberRepository.recordSyncError(phoneNumberId, syncType, event.error ?? 'unknown error')
    cloudMetrics.syncFailed(phoneNumberId, syncType)
    log.logError('sync failed', undefined, { syncType, error: event.error })
  }
}
