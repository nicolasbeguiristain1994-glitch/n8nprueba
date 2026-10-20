// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ query: vi.fn(), dbQuery: vi.fn(), scope: vi.fn(), record: vi.fn(), refresh: vi.fn(), consent: vi.fn(), send: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: m.query }))
vi.mock('@/lib/global-opt-out', () => ({ withGlobalSendGuard: m.consent, isGloballyOptedOut: vi.fn(), OPT_OUT_CANCELLED: 'cancelled', OPT_OUT_REASON: 'baja' }))
vi.mock('@/lib/cloud-api/meta-risk-refresh', () => ({ refreshCampaignMetaRisk: m.refresh }))
vi.mock('@/lib/campaign-risk', () => ({
  CampaignRiskError: class extends Error { name = 'CampaignRiskError' },
  assertCloudSendRiskClear: m.scope, recordCampaignProviderRisk: m.record, CAMPAIGN_RISK_CLEAR_SQL: 'true /* risk-clear */',
}))
import { CampaignRiskError } from '@/lib/campaign-risk'
import { CloudApiError } from '@/lib/cloud-api/errors'
import { sendQueuedWithConsent } from '@/lib/cloud-api/queued-send-guard'
let lockHeld: boolean
beforeEach(() => {
  vi.resetAllMocks()
  lockHeld = false
  m.query.mockResolvedValue([{ phone_number_id: 'phone', campaign_id: 'campaign', agent_code: 'royal', template_name: 'template' }])
  m.dbQuery.mockImplementation(async (sql: string) => ({ rows: sql.includes('cloud_messages') ? [{ status: 'queued', wamid: null }] : [{ id: 'campaign' }] }))
  m.consent.mockImplementation(async (_phone: string, fn: (db: unknown) => Promise<unknown>) => {
    lockHeld = true
    try { return await fn({ query: m.dbQuery }) } finally { lockHeld = false }
  })
  m.send.mockResolvedValue({ messages: [{ id: 'accepted' }] })
})
it('refreshes before the transaction and checks the stored campaign/template scope before sending', async () => {
  m.refresh.mockImplementation(async () => { expect(lockHeld).toBe(false) })
  m.send.mockImplementation(async () => { expect(lockHeld).toBe(true); return 'accepted' })
  expect(await sendQueuedWithConsent('message', '5491100000001', m.send)).toBe('accepted')
  expect(m.refresh).toHaveBeenCalledWith('campaign')
  expect(m.dbQuery).toHaveBeenCalledWith(expect.stringContaining('FOR SHARE OF c'), ['campaign'])
  expect(m.scope).toHaveBeenCalledWith({ campaignId: 'campaign', phoneNumberId: 'phone', templateName: 'template' }, { query: m.dbQuery })
  expect(m.scope.mock.invocationCallOrder[0]).toBeLessThan(m.send.mock.invocationCallOrder[0])
})
it.each(['hold', 'paused', 'database', 'refresh'])('finishes a definite no-send locally when blocked by %s, without retrying the provider', async reason => {
  if (reason === 'hold') m.scope.mockRejectedValue(new CampaignRiskError())
  if (reason === 'paused') m.dbQuery.mockImplementation(async (sql: string) => ({ rows: sql.includes('cloud_messages') ? [{ status: 'queued', wamid: null }] : [] }))
  if (reason === 'database') m.dbQuery.mockRejectedValue(new Error('database unavailable'))
  if (reason === 'refresh') m.refresh.mockRejectedValue(new CampaignRiskError())
  expect(await sendQueuedWithConsent('message', '5491100000001', m.send)).toBeNull()
  expect(m.send).not.toHaveBeenCalled()
  expect(m.query).toHaveBeenCalledWith(expect.stringContaining("error_title='risk-guard-no-send'"), ['message'])
  expect(m.record).not.toHaveBeenCalled()
})
it('never replays a locally cancelled queue item after a risk review', async () => {
  m.dbQuery.mockResolvedValue({ rows: [{ status: 'failed', wamid: null }] })
  expect(await sendQueuedWithConsent('message', '5491100000001', m.send)).toBeNull()
  expect(m.send).not.toHaveBeenCalled()
})
it('records known Meta rejection after the lock releases and preserves the provider failure', async () => {
  const error = new CloudApiError('Spam limit', 131048)
  m.send.mockRejectedValue(error)
  m.record.mockImplementation(async () => { expect(lockHeld).toBe(false) })
  await expect(sendQueuedWithConsent('message', '5491100000001', m.send)).rejects.toBe(error)
  expect(m.record).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 131048, campaignId: 'campaign' }))
  expect(m.query).not.toHaveBeenCalledWith(expect.stringContaining("error_title='risk-guard-no-send'"), expect.anything())
})
it('does not label a transport failure after dispatch as a known no-send', async () => {
  const error = new Error('timeout')
  m.send.mockRejectedValue(error)
  await expect(sendQueuedWithConsent('message', '5491100000001', m.send)).rejects.toBe(error)
  expect(m.query).not.toHaveBeenCalledWith(expect.stringContaining("error_title='risk-guard-no-send'"), expect.anything())
})
