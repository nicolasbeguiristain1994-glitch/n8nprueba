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

  const contactPhone = `+${msg.from}`

  await conversationRepository.openWindow(phoneNumberId, contactPhone, 'customer_initiated')

  const preview = msg.type === 'text' ? (msg.text?.body?.slice(0, 100) ?? '') : `[${msg.type}]`
  const convId  = await conversationRepository.upsertWithMessage({
    phoneNumberId, contactPhone, lastMessagePreview: preview,
  })

  await messageRepository.insertEcho({
    conversationId: convId, phoneNumberId,
    wamid: msg.id, messageType: msg.type, content: msg, timestamp: msg.timestamp,
  })

  cloudMetrics.echoReceived(phoneNumberId)
  log.logInfo('echo processed', { wamid: msg.id, type: msg.type })
}
