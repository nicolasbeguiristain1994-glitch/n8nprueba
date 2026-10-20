// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ query: vi.fn(), raise: vi.fn(), clear: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/campaign-risk', () => ({ raiseRiskIncident: mocks.raise, clearMetaRiskSignal: mocks.clear }))
import { applyPhoneQualityRisk, applyPhoneHealthRisk, type MetaHealthStatus, handleTemplateQualityRisk, handleTemplateStatusRisk, handleAccountRisk, webhookObservedAt } from '../cloud-api/webhook-handlers/meta-risk.handler'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.query.mockResolvedValue([{ phone_number_id: '12345', display_phone: '+1 555-123-4567' }])
})
const template = { message_template_id: 456, message_template_name: 'benefit', message_template_language: 'es' }
describe('Official Meta risk signals', () => {
  it.each(['YELLOW', 'RED'])('pauses on %s phone and template quality', async quality => {
    await applyPhoneQualityRisk('12345', quality, '2026-10-19T10:00:00.000Z')
    await handleTemplateQualityRisk({ ...template, new_quality_score: quality }, '23456')
    expect(mocks.raise).toHaveBeenCalledWith(expect.objectContaining({ scopeType: 'phone', scopeId: '12345', signal: 'meta_phone_quality', metrics: { quality } }))
    expect(mocks.raise).toHaveBeenCalledWith(expect.objectContaining({ scopeType: 'template', scopeId: '23456:benefit', signal: 'meta_template_quality' }))
  })
  it('green clears only the matching quality signal and pending quality clears nothing', async () => {
    await applyPhoneQualityRisk('12345', 'GREEN', '2026-10-19T10:00:00.000Z')
    await handleTemplateQualityRisk({ ...template, new_quality_score: 'GREEN' }, '23456')
    expect(mocks.clear.mock.calls.map(([value]) => value.signals)).toEqual([['meta_phone_quality'], ['meta_template_quality']])
    mocks.clear.mockClear()
    for (const quality of ['UNKNOWN', 'NA', 'UNRECOGNIZED']) {
      await applyPhoneQualityRisk('12345', quality, '2026-10-19T10:00:00.000Z')
      await handleTemplateQualityRisk({ ...template, new_quality_score: quality }, '23456')
    }
    expect(mocks.clear).not.toHaveBeenCalled(); expect(mocks.raise).not.toHaveBeenCalled()
  })
  it.each(['FLAGGED', 'PAUSED', 'DISABLED', 'REJECTED', 'ARCHIVED', 'DELETED'])('pauses the WABA-specific template on %s', async event => {
    await handleTemplateStatusRisk({ ...template, event }, '23456')
    expect(mocks.raise).toHaveBeenCalledWith(expect.objectContaining({ scopeId: '23456:benefit', signal: 'meta_template_status', metrics: expect.objectContaining({ status: event }) }))
  })
  it('approval does not clear a negative quality signal', async () => {
    await handleTemplateStatusRisk({ ...template, event: 'APPROVED' }, '23456')
    expect(mocks.clear).toHaveBeenCalledWith(expect.objectContaining({ signals: ['meta_template_status'] }))
  })
  it.each(['DISABLE', 'SCHEDULE_FOR_DISABLE'])('records the official account ban state %s', async state => {
    await handleAccountRisk({ event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: state } }, '23456')
    expect(mocks.raise).toHaveBeenCalledWith(expect.objectContaining({ scopeType: 'waba', scopeId: '23456', signal: 'meta_account_disabled', metrics: expect.objectContaining({ banState: state }) }))
  })
  it('reinstate clears only the official account restriction signals, preserving manual holds', async () => {
    await handleAccountRisk({ event: 'DISABLED_UPDATE', ban_info: { waba_ban_state: 'REINSTATE' } }, '23456')
    expect(mocks.raise).not.toHaveBeenCalled()
    expect(mocks.clear).toHaveBeenCalledWith(expect.objectContaining({ signals: ['meta_account_disabled', 'meta_account_restriction', 'meta_account_violation'] }))
  })
  it('does not confuse an omitted restriction list with an explicit empty list', async () => {
    await handleAccountRisk({ event: 'ACCOUNT_RESTRICTION' }, '23456')
    expect(mocks.raise).toHaveBeenCalledTimes(1); expect(mocks.clear).not.toHaveBeenCalled()
    await handleAccountRisk({ event: 'ACCOUNT_RESTRICTION', restriction_info: [] }, '23456')
    expect(mocks.clear).toHaveBeenCalledWith(expect.objectContaining({ signals: ['meta_account_restriction'] }))
  })
  it('matches single-number restrictions only within the trusted WABA', async () => {
    await handleAccountRisk({ event: 'ACCOUNT_VIOLATION', phone_number: '15551234567', violation_info: { violation_type: 'SPAM' } }, '23456')
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('WHERE waba_id = $1'), ['23456'])
    expect(mocks.raise).toHaveBeenCalledWith(expect.objectContaining({ scopeType: 'phone', scopeId: '12345' }))
  })
  it('ignores unknown WABAs and benign account events', async () => {
    mocks.query.mockResolvedValueOnce([])
    await handleAccountRisk({ event: 'ACCOUNT_VIOLATION' }, 'unknown')
    await handleAccountRisk({ event: 'AUTH_INTL_PRICE_ELIGIBILITY_UPDATE' }, '23456')
    expect(mocks.raise).not.toHaveBeenCalled(); expect(mocks.clear).not.toHaveBeenCalled()
  })
  it('propagates persistence failure for Meta retries', async () => {
    mocks.raise.mockRejectedValue(new Error('DB unavailable'))
    await expect(handleTemplateQualityRisk({ ...template, new_quality_score: 'RED' }, '23456')).rejects.toThrow('DB unavailable')
  })
  it('preserves provider time for out-of-order incident handling', () => {
    expect(webhookObservedAt(1792404000)).toBe(new Date(1792404000000).toISOString())
    expect(webhookObservedAt(Number.POSITIVE_INFINITY)).toBeUndefined()
  })
  const health = (): MetaHealthStatus => ({ can_send_message: 'AVAILABLE', entities: [
    { entity_type: 'PHONE_NUMBER', id: '12345', can_send_message: 'AVAILABLE' },
    { entity_type: 'WABA', id: '23456', can_send_message: 'AVAILABLE' },
    { entity_type: 'BUSINESS', id: '34567', can_send_message: 'AVAILABLE' },
    { entity_type: 'APP', id: '45678', can_send_message: 'AVAILABLE' },
  ] })
  it('detects an already blocked WABA even when number quality is green', async () => {
    const current = health(); current.can_send_message = 'BLOCKED'; current.entities[1].can_send_message = 'BLOCKED'
    current.entities[1].errors = [{ error_code: 141000, error_description: 'Messaging blocked' }]
    await applyPhoneHealthRisk('12345', '23456', current, '2026-10-19T10:00:00Z')
    expect(mocks.raise).toHaveBeenCalledWith(expect.objectContaining({ scopeType: 'waba', scopeId: '23456', signal: 'meta_account_health' }))
    expect(mocks.clear).not.toHaveBeenCalledWith(expect.objectContaining({ signals: ['meta_account_health'] }))
  })
  it('does not widen a phone-only health block to the whole WABA', async () => {
    const current = health(); current.can_send_message = 'BLOCKED'; current.entities[0].can_send_message = 'BLOCKED'
    await applyPhoneHealthRisk('12345', '23456', current, '2026-10-19T10:00:00Z')
    expect(mocks.raise).toHaveBeenCalledTimes(1)
    expect(mocks.raise).toHaveBeenCalledWith(expect.objectContaining({ scopeType: 'phone', scopeId: '12345', signal: 'meta_phone_health' }))
  })
  it('does not confuse a normal LIMITED state or a SIP calling block with ban risk', async () => {
    const current = health(); current.can_send_message = 'LIMITED'; current.entities[0].can_send_message = 'LIMITED'
    Object.assign(current.entities[3], { can_receive_call_sip: 'BLOCKED' })
    await applyPhoneHealthRisk('12345', '23456', current, '2026-10-19T10:00:00Z')
    expect(mocks.raise).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalledWith(expect.objectContaining({ signals: ['meta_phone_health'] }))
  })
  it('rejects a mismatched or incomplete health snapshot without clearing anything', async () => {
    const current = health(); current.entities[1].id = 'another-waba'
    await expect(applyPhoneHealthRisk('12345', '23456', current, '2026-10-19T10:00:00Z')).rejects.toThrow('su cuenta')
    expect(mocks.clear).not.toHaveBeenCalled(); expect(mocks.raise).not.toHaveBeenCalled()
  })
  it('health recovery never clears policy violation, scheduled ban or quality warnings', async () => {
    await applyPhoneHealthRisk('12345', '23456', health(), '2026-10-19T10:00:00Z')
    expect(mocks.clear.mock.calls.map(([value]) => value.signals)).toEqual([['meta_account_health'], ['meta_phone_health']])
  })
})
