// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ send: vi.fn(), queued: vi.fn(), sent: vi.fn(), cancel: vi.fn() }))
vi.mock('@/lib/cloud-api/token-store', () => ({ getTokenForNumber: async () => 'token' }))
vi.mock('@/lib/cloud-api/rate-limiter', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('@/lib/cloud-api/infrastructure/message-sender.service', () => ({ MessageSenderService: class { send = m.send }, buildMessagePayload: vi.fn() }))
vi.mock('@/lib/cloud-api/repositories/compliance.repository', () => ({ complianceRepository: { isOptedOut: async () => false } }))
vi.mock('@/lib/cloud-api/repositories/conversation.repository', () => ({
  conversationRepository: { upsertForOutbound: async () => 'conversation' },
  messageRepository: { insertQueued: m.queued, markSent: m.sent },
}))
vi.mock('@/lib/cloud-api/queued-send-guard', () => ({ markRiskCancelled: m.cancel, markOptOutCancelled: vi.fn() }))
vi.mock('@/lib/campaign-risk', () => ({ CampaignRiskError: class extends Error { name = 'CampaignRiskError' } }))
vi.mock('@/lib/cloud-api/message-queue', () => ({ enqueueMessage: vi.fn() }))
vi.mock('@/lib/cloud-api/infrastructure/logger', () => ({ createLogger: () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }) }))
vi.mock('@/lib/cloud-api/infrastructure/metrics', () => ({ cloudMetrics: { messageFailed: vi.fn(), messageSent: vi.fn(), messageQueued: vi.fn() } }))
import { CampaignRiskError } from '@/lib/campaign-risk'
import { SendMessageUseCase } from '@/lib/cloud-api/use-cases/send-message.use-case'
const request = { phoneNumberId: 'phone', to: '+5491100000001', type: 'template' as const,
  template: { name: 'template', language: { code: 'es' }, components: [] } }
beforeEach(() => { vi.resetAllMocks(); m.cancel.mockResolvedValue(undefined) })
it('marks a persisted outbound as definitely unsent when the final guard blocks it', async () => {
  const error = new CampaignRiskError()
  m.send.mockRejectedValue(error)
  await expect(new SendMessageUseCase().execute({ request })).rejects.toBe(error)
  const messageId = m.queued.mock.calls[0][0].id
  expect(m.cancel).toHaveBeenCalledWith(messageId)
  expect(m.sent).not.toHaveBeenCalled()
})
it('preserves the risk classification even if marking the local no-send fails', async () => {
  const error = new CampaignRiskError()
  m.send.mockRejectedValue(error)
  m.cancel.mockRejectedValue(new Error('storage unavailable'))
  await expect(new SendMessageUseCase().execute({ request })).rejects.toBe(error)
})
it('does not mark an ambiguous network failure as a definite cancellation', async () => {
  m.send.mockRejectedValue(new Error('timeout'))
  await expect(new SendMessageUseCase().execute({ request })).rejects.toThrow('timeout')
  expect(m.cancel).not.toHaveBeenCalled()
})
