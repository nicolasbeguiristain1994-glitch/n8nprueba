// Handler: mensaje entrante de un cliente (field 'messages', direction inbound).

import { conversationRepository, messageRepository } from '../repositories/conversation.repository'
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

  await conversationRepository.openWindow(phoneNumberId, contactPhone, 'customer_initiated')

  if (msg.type === 'text' && msg.text?.body) {
    const isStop = await complianceRepository.matchesStopKeyword(msg.text.body)
    if (isStop) {
      await complianceRepository.recordOptOut({
        phone: contactPhone, phoneNumberId,
        reason: 'stop_keyword', wamid: msg.id,
        metadata: { keyword: msg.text.body.trim().toUpperCase() },
      })
      cloudMetrics.optOut(phoneNumberId, 'stop_keyword')
      log.logInfo('opt_out detected', { wamid: msg.id })
      return
    }
  }

  if (profileName) {
    void conversationRepository.updateContactDisplayName(contactPhone, profileName)
  }

  const preview = msg.type === 'text' ? (msg.text?.body?.slice(0, 100) ?? '') : `[${msg.type}]`
  const convId  = await conversationRepository.upsertWithMessage({ phoneNumberId, contactPhone, lastMessagePreview: preview })

  await messageRepository.insertInbound({
    conversationId: convId, phoneNumberId,
    wamid: msg.id, messageType: msg.type, content: msg, timestamp: msg.timestamp,
  })

  cloudMetrics.messageReceived(phoneNumberId, msg.type)
  log.logInfo('processed', { wamid: msg.id, type: msg.type })
}
