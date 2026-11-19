import { recordInboundSubscription } from '@/lib/line-subscriptions'
import { processSubscriptionFlow } from '@/lib/line-subscription-flow'
import { isSubscriptionStop } from '@/lib/line-subscription-message'
// Handler: mensaje entrante de un cliente (field 'messages', direction inbound).

import { evaluateAutomations } from '@/lib/automation-engine'
import { cloudMessageText } from '../message-content'
import { cloudOptOutCandidates } from '@/lib/opt-out-command'
import { sendOptOutConfirmation } from '@/lib/opt-out-confirmation'
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

  const contactPhone = `+${msg.from.replace(/^\+/, '')}`
  const profileName  = contacts.find(c => c.wa_id === msg.from)?.profile.name ?? null

  if (msg.type === 'reaction') {
    await conversationRepository.receiveReaction(phoneNumberId,contactPhone,msg,'inbound')
    sseEmitter.emit('update', {source:'reaction',phone:contactPhone})
    return
  }

  // Persist the original event once; retries must not reopen the 24-hour window.
  await conversationRepository.receive(phoneNumberId, contactPhone, msg)
  sseEmitter.emit('update', { source: 'message', phone: contactPhone })

  const inboundText = cloudMessageText(msg, msg.type)
  if (msg.type === 'text' && inboundText && await processSubscriptionFlow({provider:'cloud',sourceId:phoneNumberId,
    phone:contactPhone,text:inboundText,messageId:msg.id,timestamp:msg.timestamp,profileName})) return
  for (const command of cloudOptOutCandidates(msg).filter(Boolean)) {
    const isStop = isSubscriptionStop(command) || await complianceRepository.matchesStopKeyword(command)
    if (isStop) {
      if (msg.type !== 'text' && await processSubscriptionFlow({provider:'cloud',sourceId:phoneNumberId,
        phone:contactPhone,text:command,messageId:msg.id,timestamp:msg.timestamp,profileName})) return
      await recordInboundSubscription({provider:'cloud',sourceId:phoneNumberId,phone:contactPhone,
        text:command,messageId:msg.id,timestamp:msg.timestamp,isStop:true})
      const confirmation = command.trim().toUpperCase() === 'BAJA'
      await complianceRepository.recordOptOut({
        phone: contactPhone, phoneNumberId,
        reason: 'stop_keyword', wamid: msg.id,
        metadata: { keyword: command.trim().toUpperCase(), input_type: msg.type, context_wamid: msg.context?.id },
        confirmation,
      })
      if (confirmation) await sendOptOutConfirmation({ phone: contactPhone, sourceId: phoneNumberId, messageId: msg.id, provider: 'cloud' })
      sseEmitter.emit('update', { source: 'message', phone: contactPhone })
      cloudMetrics.optOut(phoneNumberId, 'stop_keyword')
      log.logInfo('opt_out detected', { wamid: msg.id })
      return
    }
  }

  if (msg.type === 'text' && inboundText && await recordInboundSubscription({provider:'cloud',
    sourceId:phoneNumberId,phone:contactPhone,text:inboundText,messageId:msg.id,timestamp:msg.timestamp})) return

  if (profileName) {
    void conversationRepository.updateContactDisplayName(contactPhone, profileName)
  }


  await evaluateAutomations(msg.from, inboundText, msg.id, { provider: 'cloud', phoneNumberId,
    ...(msg.context?.id ? {contextWamid:msg.context.id} : {}), receivedAt:new Date(Number(msg.timestamp)*1000) })

  cloudMetrics.messageReceived(phoneNumberId, msg.type)
  log.logInfo('processed', { wamid: msg.id, type: msg.type })
}
