// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), txQuery: vi.fn(), identity: vi.fn(), evaluate: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
vi.mock('@/lib/consent-context', () => ({ resolveConsentIdentity: mocks.identity }))
vi.mock('@/lib/campaign-risk', () => ({ evaluateCampaignRisk: mocks.evaluate }))
import { recordGlobalOptOut } from '../global-opt-out'
const request = { phone: '+5491100000001', sourceId: '12345', messageId: 'wamid.stop', text: 'BAJA', provider: 'cloud' as const }
let committed: boolean
let existing: boolean
beforeEach(() => {
  vi.resetAllMocks(); committed = false; existing = false
  mocks.identity.mockResolvedValue({ agent: 'royal', campaignId: 'campaign-id', sourceKey: 'cloud:12345' })
  mocks.txQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith("SELECT metadata->>'campaign_id'")) return { rows: existing ? [{ campaign_id: 'campaign-id' }] : [] }
    if (sql.startsWith('INSERT INTO blacklist')) return { rows: [{ id: 'blacklist-id' }] }
    return { rows: [] }
  })
  mocks.transaction.mockImplementation(async fn => {
    const result = await fn({ query: mocks.txQuery })
    committed = true; existing = true
    return result
  })
})
it('preserves the baja commit when risk evaluation fails, then re-evaluates a duplicate webhook', async () => {
  mocks.evaluate.mockImplementationOnce(async () => {
    expect(committed).toBe(true)
    throw new Error('Risk store unavailable')
  })
  await expect(recordGlobalOptOut(request)).rejects.toThrow('Risk store unavailable')
  expect(committed).toBe(true)
  await recordGlobalOptOut(request)
  expect(mocks.evaluate).toHaveBeenCalledTimes(2)
  expect(mocks.evaluate).toHaveBeenLastCalledWith('campaign-id')
  expect(mocks.identity).toHaveBeenCalledTimes(1)
  expect(mocks.txQuery.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO cloud_consent_log'))).toHaveLength(1)
})
it('never evaluates before consent persistence succeeds', async () => {
  mocks.txQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith('INSERT INTO blacklist')) throw new Error('Consent store unavailable')
    return { rows: [] }
  })
  await expect(recordGlobalOptOut(request)).rejects.toThrow('Consent store unavailable')
  expect(committed).toBe(false); expect(mocks.evaluate).not.toHaveBeenCalled()
})
