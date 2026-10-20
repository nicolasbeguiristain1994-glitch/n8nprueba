// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ query: vi.fn(), status: vi.fn(), risk: vi.fn(), evaluate: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/campaign-test-delivery', () => ({ recordCampaignTestDelivery: vi.fn() }))
vi.mock('@/lib/campaign-risk', () => ({ recordCampaignProviderRisk: mocks.risk, evaluateCampaignRisk: mocks.evaluate }))
vi.mock('@/lib/cloud-api/repositories/conversation.repository', () => ({ messageRepository: { updateStatus: mocks.status } }))
vi.mock('@/lib/cloud-api/infrastructure/metrics', () => ({ cloudMetrics: { deliveryStatus: vi.fn() } }))
vi.mock('@/lib/cloud-api/infrastructure/logger', () => ({ createLogger: () => ({ logInfo: vi.fn() }) }))
import { handleDeliveryStatus } from '../cloud-api/webhook-handlers/delivery-status.handler'
const failed = { id: 'wamid.test', status: 'failed' as const, timestamp: '1792404000', recipient_id: 'recipient', errors: [{ code: 131049, title: 'Healthy ecosystem engagement' }] }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.query.mockImplementation(async (sql: string) => sql.startsWith('SELECT cr.campaign_id')
    ? [{ campaign_id: 'campaign-id', template_name: 'benefit', status: 'failed' }] : [])
})
it('evaluates the attributed campaign after persisting its failure', async () => {
  await handleDeliveryStatus('12345', failed, 'test')
  expect(mocks.risk).toHaveBeenCalledWith(expect.objectContaining({ campaignId: 'campaign-id', phoneNumberId: '12345', templateName: 'benefit', errorCode: 131049 }))
  expect(mocks.evaluate).toHaveBeenCalledWith('campaign-id')
  expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(mocks.risk.mock.invocationCallOrder[0])
})
it('re-evaluates a repeated delivery receipt when risk persistence initially failed', async () => {
  mocks.risk.mockRejectedValueOnce(new Error('DB unavailable'))
  await expect(handleDeliveryStatus('12345', failed, 'test')).rejects.toThrow('DB unavailable')
  await handleDeliveryStatus('12345', failed, 'test')
  expect(mocks.risk).toHaveBeenCalledTimes(2)
  expect(mocks.evaluate).toHaveBeenCalledTimes(1)
})
it('does not interpret a stale failed receipt after delivery as a fresh risk', async () => {
  mocks.query.mockImplementation(async (sql: string) => sql.startsWith('SELECT cr.campaign_id')
    ? [{ campaign_id: 'campaign-id', status: 'delivered' }] : [])
  await handleDeliveryStatus('12345', failed, 'test')
  expect(mocks.risk).not.toHaveBeenCalled(); expect(mocks.evaluate).not.toHaveBeenCalled()
})
it('does not acknowledge persistence failure before evaluating risk', async () => {
  mocks.query.mockRejectedValue(new Error('DB unavailable'))
  await expect(handleDeliveryStatus('12345', failed, 'test')).rejects.toThrow('DB unavailable')
  expect(mocks.risk).not.toHaveBeenCalled()
})
