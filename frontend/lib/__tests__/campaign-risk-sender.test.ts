// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ query: vi.fn(), guardQuery: vi.fn(), assert: vi.fn(), record: vi.fn(), post: vi.fn(), transactionOpen: false }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/campaign-risk', () => ({
  CampaignRiskError: class extends Error { status = 409; code = 'CAMPAIGN_RISK_BLOCKED' },
  CAMPAIGN_RISK_CLEAR_SQL: 'true /* campaign-risk-clear */',
  assertCloudSendRiskClear: mocks.assert, recordCampaignProviderRisk: mocks.record,
}))
vi.mock('@/lib/global-opt-out', () => ({ withGlobalSendGuard: async (_phone: string, fn: (db: unknown) => Promise<unknown>) => {
  mocks.transactionOpen = true
  try { return await fn({ query: mocks.guardQuery }) } finally { mocks.transactionOpen = false }
} }))
vi.mock('@/lib/cloud-api/infrastructure/meta-http.gateway', () => ({ MetaHttpGateway: class { post = mocks.post } }))
import { MessageSenderService } from '@/lib/cloud-api/infrastructure/message-sender.service'
import { CampaignRiskError } from '@/lib/campaign-risk'
import { CloudApiError } from '@/lib/cloud-api/errors'
import type { SendMessageRequest } from '@/lib/cloud-api/types/messages'
const req: SendMessageRequest = { phoneNumberId: 'phone', to: '+5491112345678', type: 'template', campaignId: 'campaign',
  template: { name: 'beneficio', language: { code: 'es_AR' }, components: [] } }
const sender = new MessageSenderService('synthetic-token', 'phone')
beforeEach(() => {
  vi.resetAllMocks()
  mocks.transactionOpen = false
  mocks.guardQuery.mockResolvedValue({ rows: [{ id: 'campaign' }] })
  mocks.post.mockResolvedValue({ messages: [{ id: 'wamid.accepted' }] })
  mocks.query.mockResolvedValue([])
})
describe('last-mile campaign safety guard', () => {
  it('checks campaign state and risk inside the transaction before calling Meta', async () => {
    mocks.assert.mockImplementation(async () => { expect(mocks.transactionOpen).toBe(true) })
    mocks.post.mockImplementation(async () => {
      expect(mocks.transactionOpen).toBe(true)
      expect(mocks.assert).toHaveBeenCalled()
      return { messages: [{ id: 'wamid.accepted' }] }
    })
    expect(await sender.send(req)).toEqual({ wamid: 'wamid.accepted' })
    expect(mocks.guardQuery).toHaveBeenCalledWith(expect.stringContaining('FOR SHARE OF c'), ['campaign'])
    expect(mocks.guardQuery.mock.calls[0][0]).toContain("c.status='running'")
    expect(mocks.assert).toHaveBeenCalledWith({ campaignId: 'campaign', phoneNumberId: 'phone', templateName: 'beneficio' }, { query: mocks.guardQuery })
  })
  it('does not call Meta for a stopped or held campaign', async () => {
    mocks.guardQuery.mockResolvedValue({ rows: [] })
    await expect(sender.send(req)).rejects.toBeInstanceOf(CampaignRiskError)
    expect(mocks.post).not.toHaveBeenCalled()
  })
  it('does not call Meta after a stored number/template hold', async () => {
    mocks.assert.mockRejectedValue(new CampaignRiskError('Calidad baja'))
    await expect(sender.send(req)).rejects.toThrow('Calidad baja')
    expect(mocks.post).not.toHaveBeenCalled()
  })
  it('treats safety-read failure as known no-send, not unknown provider outcome', async () => {
    mocks.assert.mockRejectedValue(new Error('DB unavailable'))
    await expect(sender.send(req)).rejects.toBeInstanceOf(CampaignRiskError)
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it('checks scope risk for draft tests without requiring a running campaign', async () => {
    await sender.send({ ...req, campaignId: undefined })
    expect(mocks.guardQuery).not.toHaveBeenCalled()
    expect(mocks.assert).toHaveBeenCalled()
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })
  it('records a provider restriction after releasing the campaign lock', async () => {
    const error = new CloudApiError('Restricted', 131048)
    mocks.post.mockRejectedValue(error)
    mocks.record.mockImplementation(async () => { expect(mocks.transactionOpen).toBe(false) })
    await expect(sender.send(req)).rejects.toBe(error)
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ campaignId: 'campaign', errorCode: 131048 }))
  })
  it('preserves a definite Meta rejection and stops the campaign if incident persistence fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new CloudApiError('Restricted', 131048)
    mocks.post.mockRejectedValue(error)
    mocks.record.mockRejectedValue(new Error('DB failed'))
    await expect(sender.send(req)).rejects.toBe(error)
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("pause_reason='risk_detected'"), ['campaign'])
    vi.restoreAllMocks()
  })
})
