// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), txQuery: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
import { evaluateCampaignRisk, recordCampaignProviderRisk } from '../campaign-risk'
beforeEach(() => {
  vi.resetAllMocks()
  mocks.query.mockResolvedValue([{ delivered: 0, optouts: 0, attempts: 0, ecosystem: 0 }])
  mocks.txQuery.mockResolvedValue({ rows: [] })
  mocks.transaction.mockImplementation(async fn => fn({ query: mocks.txQuery }))
})
function signals() {
  return mocks.txQuery.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO campaign_risk_signals')).map(([, params]) => params[2])
}
describe('Preventive panel thresholds, not official Meta ban thresholds', () => {
  it.each([
    [49, 5, false], [50, 4, false], [50, 5, true], [100, 5, true], [101, 5, false], [0, 0, false],
  ])('requires both sample and rate for %i delivered / %i bajas', async (delivered, optouts, expected) => {
    mocks.query.mockResolvedValue([{ delivered, optouts, attempts: delivered, ecosystem: 0 }])
    await evaluateCampaignRisk('campaign-id')
    expect(signals()).toEqual(expected ? ['panel_opt_out_rate'] : [])
  })
  it.each([
    [49, 10, false], [50, 9, false], [50, 10, true], [100, 20, true], [101, 20, false], [0, 0, false],
  ])('requires both sample and rate for %i attempts / %i ecosystem rejections', async (attempts, ecosystem, expected) => {
    mocks.query.mockResolvedValue([{ delivered: 0, optouts: 0, attempts, ecosystem }])
    await evaluateCampaignRisk('campaign-id')
    expect(signals()).toEqual(expected ? ['panel_ecosystem_rate'] : [])
  })
  it.each([131026, 130472, 131042, 131047, 999999])('does not claim recipient/payment/window error %i is ban risk', async errorCode => {
    await recordCampaignProviderRisk({ campaignId: 'campaign-id', phoneNumberId: '12345', errorCode })
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('treats one 131049 as evidence for aggregate evaluation, not an immediate official account restriction', async () => {
    await recordCampaignProviderRisk({ campaignId: 'campaign-id', phoneNumberId: '12345', errorCode: 131049 })
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it('scope-isolates a paused template by WABA and template name', async () => {
    mocks.query.mockResolvedValue([{ waba_id: '23456' }])
    await recordCampaignProviderRisk({ phoneNumberId: '12345', templateName: 'benefit', errorCode: 132015 })
    const [, params] = mocks.txQuery.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO campaign_risk_signals'))!
    expect(params.slice(0, 4)).toEqual(['template', '23456:benefit', 'meta_template_status', 'meta'])
  })
})
