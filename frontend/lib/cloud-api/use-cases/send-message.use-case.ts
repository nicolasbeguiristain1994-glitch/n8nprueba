// Caso de uso: enviar un mensaje via Cloud API.
// Orquesta: compliance → ventana → rate limit → sender → persistencia.

import { randomUUID }                         from 'crypto'
import { getTokenForNumber }                  from '../token-store'
import { MessageSenderService, buildMessagePayload } from '../infrastructure/message-sender.service'
import { enforceRateLimit }                   from '../rate-limiter'
import { conversationRepository, messageRepository } from '../repositories/conversation.repository'
import { complianceRepository }               from '../repositories/compliance.repository'
import { cloudMetrics }                       from '../infrastructure/metrics'
import { createLogger }                       from '../infrastructure/logger'
import { createCorrelationId }                from '../correlation'
import type { SendMessageRequest, SendMessageResult } from '../types/messages'
import { OptOutError, ConversationWindowError, CloudApiError } from '../errors'
import { enqueueMessage }                     from '../message-queue'

export interface SendMessageInput {
  request:        SendMessageRequest
  enqueue?:       boolean   // true para campañas masivas
  correlationId?: string    // propagado desde el caller; se genera si ausente
}

export class SendMessageUseCase {
  async execute(input: SendMessageInput): Promise<SendMessageResult> {
    const { request: req, enqueue = false } = input
    const { phoneNumberId, to, type }        = req
    const correlationId = input.correlationId ?? createCorrelationId()
    const log = createLogger({ correlationId, phoneNumberId, operation: 'send_message' })

    // 1. Compliance: opt-out
    const optedOut = await complianceRepository.isOptedOut(to, phoneNumberId)
    if (optedOut) throw new OptOutError(to)

    // 2. Ventana de servicio (solo para mensajes no-plantilla)
    if (type !== 'template') {
      const window = await conversationRepository.findWindow(phoneNumberId, to)
      const isOpen = window?.windowExpiresAt != null && window.windowExpiresAt > new Date()
      if (!isOpen) throw new ConversationWindowError()
    }

    const messageId = randomUUID()

    if (enqueue) return this.enqueue(messageId, req, log)
    return this.sendImmediate(messageId, req, log)
  }

  private async enqueue(
    messageId: string,
    req:       SendMessageRequest,
    log:       ReturnType<typeof createLogger>,
  ): Promise<SendMessageResult> {
    const { phoneNumberId, to, type } = req

    const convId = await conversationRepository.upsertForOutbound(phoneNumberId, to)
    await messageRepository.insertQueued({
      id: messageId, conversationId: convId, phoneNumberId,
      messageType: type, content: req,
      campaignId: req.campaignId, sentByUserId: req.sentByUserId,
    })

    // El rate limit real lo aplica BullMQ (limiter: max 20/s) en el worker.
    // No se consume token aquí para no competir con los envíos inmediatos concurrentes.
    const rawPayload = buildMessagePayload(req)
    await enqueueMessage({
      jobId: messageId, messageId, phoneNumberId, to,
      payload: rawPayload, attempts: 0, campaignId: req.campaignId,
    })

    cloudMetrics.messageQueued(phoneNumberId, type)
    log.logInfo('enqueued', { messageId, type })
    return { messageId, wamid: '', status: 'queued' }
  }

  private async sendImmediate(
    messageId: string,
    req:       SendMessageRequest,
    log:       ReturnType<typeof createLogger>,
  ): Promise<SendMessageResult> {
    const { phoneNumberId, to, type } = req

    // Rate limit: 20 msg/s por número (Coexistence)
    await enforceRateLimit(phoneNumberId)

    const accessToken = await getTokenForNumber(phoneNumberId)
    const sender      = new MessageSenderService(accessToken, phoneNumberId)

    const timer = Date.now()
    try {
      const { wamid } = await sender.send(req)

      const convId = await conversationRepository.upsertForOutbound(phoneNumberId, to)
      await messageRepository.insertOutbound({
        id: messageId, conversationId: convId, phoneNumberId, wamid,
        messageType: type, content: req,
        templateName: type === 'template' ? req.template?.name : undefined,
        campaignId: req.campaignId, sentByUserId: req.sentByUserId,
      })

      cloudMetrics.messageSent(phoneNumberId, type, Date.now() - timer)
      log.logInfo('sent', { messageId, wamid, type })
      return { messageId, wamid, status: 'sent' }

    } catch (err) {
      cloudMetrics.messageFailed(phoneNumberId, type, err instanceof CloudApiError ? err.code : undefined)
      log.logError('send failed', err, { messageId })
      throw err
    }
  }
}

export const sendMessageUseCase = new SendMessageUseCase()
