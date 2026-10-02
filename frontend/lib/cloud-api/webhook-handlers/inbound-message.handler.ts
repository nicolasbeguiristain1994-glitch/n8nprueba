// Handler: mensaje entrante de un cliente (field 'messages', direction inbound).

import { evaluateAutomations } from '@/lib/automation-engine'
import { cloudMessageText } from '../message-content'
import { sseEmitter } from '@/lib/sse-events'
import { conversationRepository } from '../repositories/conversation.repository'
import { complianceRepository }                      from '../repositories/compliance.repository'
import { cloudMetrics }                              from '../infrastructure/metrics'
import { createLogger }                              from '../infrastructure/logger'
import type { WebhookMessage, WebhookContact }       from '../types/webhooks'

export async function handleInboundMessage(
  phoneNumberId: string,
  msg:           WebhookMessage,
  contacts:      WebhookContact[],
  correlationId: string,
): Promise<void> {
  const log = createLogger({ correlationId, phoneNumberId, operation: 'inbound_message' })

  const contactPhone = `+${msg.from}`
  const profileName  = contacts.find(c => c.wa_id === msg.from)?.profile.name ?? null

  // Persist the original event once; retries must not reopen the 24-hour window.
  await conversationRepository.receive(phoneNumberId, contactPhone, msg)
  sseEmitter.emit('update', { source: 'message' })

  const inboundText = cloudMessageText(msg, msg.type)
  if (inboundText) {
    const isStop = await complianceRepository.matchesStopKeyword(inboundText)
    if (isStop) {
      await complianceRepository.recordOptOut({
        phone: contactPhone, phoneNumberId,
        reason: 'stop_keyword', wamid: msg.id,
        metadata: { keyword: inboundText.trim().toUpperCase() },
      })
      cloudMetrics.optOut(phoneNumberId, 'stop_keyword')
      log.logInfo('opt_out detected', { wamid: msg.id })
      return
    }
  }

  if (profileName) {
    void conversationRepository.updateContactDisplayName(contactPhone, profileName)
  }


  await evaluateAutomations(msg.from, inboundText, msg.id, { provider: 'cloud', phoneNumberId })

  cloudMetrics.messageReceived(phoneNumberId, msg.type)
  log.logInfo('processed', { wamid: msg.id, type: msg.type })
}
