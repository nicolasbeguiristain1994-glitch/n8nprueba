// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn(), token: vi.fn(), raise: vi.fn(), clear: vi.fn(), phone: vi.fn(), health: vi.fn(), quality: vi.fn(), status: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/campaign-risk', () => ({ raiseRiskIncident: mocks.raise, clearMetaRiskSignal: mocks.clear, CampaignRiskError: class extends Error {} }))
vi.mock('@/lib/cloud-api/token-store', () => ({ getTokenForNumber: mocks.token }))
vi.mock('@/lib/cloud-api/infrastructure/meta-http.gateway', () => ({ MetaHttpGateway: class { get = mocks.get } }))
vi.mock('@/lib/cloud-api/webhook-handlers/meta-risk.handler', () => ({ applyPhoneQualityRisk: mocks.phone, applyPhoneHealthRisk: mocks.health, handleTemplateQualityRisk: mocks.quality, handleTemplateStatusRisk: mocks.status }))
import { refreshCampaignMetaRisk, refreshPhoneMetaRisk } from '../cloud-api/meta-risk-refresh'
const phone = { phone_number_id: '12345', waba_id: '23456', risk_checked_at: null }
const template = { id: 'template-id', waba_id: '23456', whatsapp_template_id: '34567', name: 'benefit', language: 'es', risk_checked_at: null }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.token.mockResolvedValue('private-token')
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT waba_id')) return [{ waba_id: '23456' }]
    if (sql.startsWith('SELECT message_type')) return [{ message_type: 'template', template_id: 'template-id', owned_by: 'operator-id', use_multi_line: true }]
    if (sql.includes('FROM whatsapp_templates WHERE id=')) return [template]
    if (sql.includes('FROM cloud_numbers cn')) return [phone]
    return []
  })
  mocks.get.mockImplementation(async (path: string) => path.startsWith('/12345')
    ? { id: '12345', quality_rating: 'GREEN', verified_name: 'Business', health_status: { entities: [] } }
    : { id: '34567', name: 'benefit', language: 'es', status: 'APPROVED', quality_score: { score: 'UNKNOWN' } })
})
describe('Meta risk preflight', () => {
  it('checks current phone and template quality and writes freshness only after processing', async () => {
    await refreshCampaignMetaRisk('campaign-id')
    expect(mocks.phone).toHaveBeenCalledWith('12345', 'GREEN', expect.any(String))
    expect(mocks.quality).toHaveBeenCalledWith(expect.objectContaining({ new_quality_score: 'UNKNOWN' }), '23456', expect.any(String))
    expect(mocks.clear).toHaveBeenCalledWith(expect.objectContaining({ scopeType: 'campaign', signals: ['meta_check_unavailable'] }))
    const phoneWrite = mocks.query.mock.calls.findIndex(([sql]) => sql.startsWith('UPDATE cloud_numbers'))
    expect(phoneWrite).toBeGreaterThan(-1)
    expect(mocks.phone.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[phoneWrite])
  })
  it('uses the campaign owner visibility and template WABA', async () => {
    await refreshCampaignMetaRisk('campaign-id')
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('get_accessible_line_ids($2::uuid)'), ['23456', 'operator-id'])
  })
  it('does not poll unrelated Cloud lines for a legacy Evolution campaign', async () => {
    mocks.query.mockResolvedValue([{ message_type: 'text', use_multi_line: false }])
    await refreshCampaignMetaRisk('campaign-id')
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.raise).not.toHaveBeenCalled()
  })
  it('uses a short database freshness cache but still leaves incident review to the core', async () => {
    const checked = new Date()
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT message_type')) return [{ message_type: 'template', template_id: 'template-id', owned_by: null, use_multi_line: true }]
      if (sql.includes('FROM whatsapp_templates WHERE id=')) return [{ ...template, risk_checked_at: checked }]
      if (sql.includes('FROM cloud_numbers cn')) return [{ ...phone, risk_checked_at: checked }]
      return []
    })
    await refreshCampaignMetaRisk('campaign-id')
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.clear).toHaveBeenCalledWith(expect.objectContaining({ signals: ['meta_check_unavailable'] }))
  })
  it('raises an outage hold and fails closed when Meta is unavailable', async () => {
    mocks.get.mockRejectedValue(new Error('upstream timeout'))
    await expect(refreshCampaignMetaRisk('campaign-id')).rejects.toThrow('permanece detenida')
    expect(mocks.raise).toHaveBeenCalledWith(expect.objectContaining({ scopeType: 'campaign', scopeId: 'campaign-id', source: 'panel', signal: 'meta_check_unavailable' }))
    expect(mocks.clear).not.toHaveBeenCalled()
  })
  it('never caches a warning whose hold could not be persisted', async () => {
    mocks.phone.mockRejectedValue(new Error('DB unavailable'))
    await expect(refreshPhoneMetaRisk('12345')).rejects.toThrow('DB unavailable')
    expect(mocks.query).not.toHaveBeenCalledWith(expect.stringContaining('risk_checked_at='), expect.anything())
  })
  it('rejects a mismatched Meta object instead of caching it as healthy', async () => {
    mocks.get.mockResolvedValue({ id: 'another-number', quality_rating: 'GREEN' })
    await expect(refreshPhoneMetaRisk('12345')).rejects.toThrow('calidad válida')
    expect(mocks.phone).not.toHaveBeenCalled()
  })
  it('allows pending review without a quality score but does not invent green', async () => {
    mocks.get.mockImplementation(async (path: string) => path.startsWith('/12345')
      ? { id: '12345', quality_rating: 'NA', health_status: { entities: [] } }
      : { id: '34567', name: 'benefit', language: 'es', status: 'PENDING' })
    await refreshCampaignMetaRisk('campaign-id')
    expect(mocks.quality).toHaveBeenCalledWith(expect.objectContaining({ new_quality_score: 'UNKNOWN' }), '23456', expect.any(String))
  })
})
