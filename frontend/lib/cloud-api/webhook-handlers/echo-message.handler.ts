// Handler: mensajes enviados desde la WhatsApp Business App (smb_message_echoes).
// Coexistence los refleja para mantener historial unificado.

import { conversationRepository, messageRepository } from '../repositories/conversation.repository'
import { cloudMetrics }                              from '../infrastructure/metrics'
import { createLogger }                              from '../infrastructure/logger'
import type { WebhookMessage }                       from '../types/webhooks'

export async function handleEchoMessage(
  phoneNumberId: string,
  msg:           WebhookMessage,
  correlationId: string,
): Promise<void> {
  const log = createLogger({ correlationId, phoneNumberId, operation: 'echo_message' })

  if (!msg.to) return
  const contactPhone = `+${msg.to.replace(/^\+/, '')}`

  // An outbound echo cannot open the customer's service window.
  const convId = await conversationRepository.upsertForOutbound(phoneNumberId, contactPhone)

  await messageRepository.insertEcho({
    conversationId: convId, phoneNumberId,
    wamid: msg.id, messageType: msg.type, content: msg, timestamp: msg.timestamp,
  })

  cloudMetrics.echoReceived(phoneNumberId)
  log.logInfo('echo processed', { wamid: msg.id, type: msg.type })
}
