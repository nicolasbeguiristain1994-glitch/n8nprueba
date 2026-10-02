/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(), send: vi.fn(), rate: vi.fn(), token: vi.fn(), optedOut: vi.fn(), window: vi.fn(),
  updateActivity: vi.fn(), delay: vi.fn(), personality: vi.fn(), loadedPersonality: vi.fn(), activeNow: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: vi.fn() }))
vi.mock('@/lib/cloud-api/rate-limiter', () => ({ enforceRateLimit: mocks.rate }))
vi.mock('@/lib/cloud-api/token-store', () => ({ getTokenForNumber: mocks.token }))
vi.mock('@/lib/cloud-api/repositories/compliance.repository', () => ({ complianceRepository: { isOptedOut: mocks.optedOut } }))
vi.mock('@/lib/cloud-api/repositories/conversation.repository', () => ({ conversationRepository: { findWindow: mocks.window } }))
vi.mock('@/lib/cloud-api/infrastructure/message-sender.service', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/cloud-api/infrastructure/message-sender.service')>(),
  MessageSenderService: class { send = mocks.send },
}))
vi.mock('@/lib/contact-frequency/ContactFrequencyEngine', () => ({ ContactFrequencyEngine: { atomicEvaluateAndRecord: vi.fn() } }))
vi.mock('@/lib/campaign-logger', () => ({ clog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), critical: vi.fn() } }))
vi.mock('@/lib/line-personality', () => ({
  updateLastActiveAt: mocks.updateActivity, getLoadedLineIds: () => [], getLoadedPersonality: mocks.loadedPersonality,
  getLinePersonality: mocks.personality, hydratePersonalityFromRecord: vi.fn(), evictPersonality: vi.fn(),
  shouldLineBeActiveNow: mocks.activeNow, savePersonalityToDB: vi.fn(), getAdjustedDelayConfig: vi.fn(),
}))
vi.mock('@/lib/proxy-manager', () => ({ flushExpiredBlacklist: () => 0, getProxyForLine: vi.fn(), reportProxySendFailure: vi.fn() }))
vi.mock('@/lib/anti-ban-delays', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/anti-ban-delays')>(), humanLikeDelay: mocks.delay,
}))

import {
  buildTemplatePayload, sendViaCloud, sendOneUnit, processMultiLineInBackground, CampaignLineUnavailableError, CloudSendOutcomeUnknownError,
  type CampaignForDispatch, type EligibleLine,
} from '@/lib/campaign-distributor'
import { CloudApiError, ConversationWindowError, OptOutError } from '@/lib/cloud-api/errors'

const line: EligibleLine = {
  id: 'line-1', line_type: 'cloud', phone_number_id: '1291177454085092', waba_id: '1124300660047709',
  evolution_instance: null, evolution_url: null, msgs_sent_hour: 0, msgs_sent_today: 0,
  msg_per_hour: 50, msg_per_day: 500, priority: 1, last_seen_at: null,
  remaining_hour: 50, remaining_day: 500, has_personality: false,
}
const campaign: CampaignForDispatch = {
  id: 'campaign-1', name: 'Test', message: 'Hola', messages: null, media_url: null, list_id: 'list-1',
  antiblock_delay_min: 1, antiblock_delay_max: 2, personalize_name: true, status: 'running', owned_by: null,
  message_type: 'template', template_id: 'template-1', template_name: 'greeting', template_language: 'es_AR',
  template_waba_id: line.waba_id, template_status: 'APROBADA', template_params: {},
}
const unit = { id: 'recipient-1', contact_id: null, prospect_id: 'prospect-1',
  phone_number: '+5492230000000', first_name: 'Ana', attempts: 1 }
const templatePayload = () => ({ kind: 'template' as const, content: buildTemplatePayload(campaign, unit),
  wabaId: campaign.template_waba_id!, templateId: campaign.template_id! })

function successfulDb(sql: string) {
  if (sql.includes('WITH claimed AS')) return Promise.resolve([unit])
  if (sql.includes('INSERT INTO whatsapp_messages') && sql.includes('RETURNING id')) return Promise.resolve([{ id: 'message-1' }])
  if (sql.includes('SELECT cn.waba_id')) return Promise.resolve([{ waba_id: line.waba_id }])
  if (sql.includes('SELECT id FROM whatsapp_templates')) return Promise.resolve([{ id: campaign.template_id }])
  return Promise.resolve([])
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.query.mockImplementation(successfulDb)
  mocks.optedOut.mockResolvedValue(false)
  mocks.window.mockResolvedValue({ windowExpiresAt: new Date(Date.now() + 60000) })
  mocks.rate.mockResolvedValue(undefined)
  mocks.token.mockResolvedValue('synthetic-token')
  mocks.send.mockResolvedValue({ wamid: 'wamid.test' })
  mocks.updateActivity.mockImplementation(() => {})
  mocks.delay.mockResolvedValue(undefined)
  mocks.personality.mockResolvedValue(null)
  mocks.loadedPersonality.mockReturnValue(null)
  mocks.activeNow.mockReturnValue(true)
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected real transport') }))
  vi.stubEnv('EVOLUTION_API_KEY', 'synthetic-key')
})

describe('Cloud campaign template and send guards', () => {
  it.each(['{{first_name}}', '{{nombre}}', '{{ name }}'])('personalizes %s for each recipient without changing fixed parameters', variable => {
    const personalized = { ...campaign, personalize_name: false, template_params: { body: [variable, '$3.000'] } }
    for (const [stored, expected] of [[' pablo ', 'Pablo'], ['maría', 'María']]) {
      const result = buildTemplatePayload(personalized, { ...unit, first_name: stored })
      expect(result.components).toEqual([
        { type: 'body', parameters: [{ type: 'text', text: expected }, { type: 'text', text: '$3.000' }] },
      ])
    }
    expect(personalized.template_params.body).toEqual([variable, '$3.000'])
  })

  it('preserves literal values and button identifiers while formatting names in the body', () => {
    const result = buildTemplatePayload({ ...campaign, template_params: {
      body: ['nombre', '{{first_name}}'],
      buttons: [{ index: 0, sub_type: 'quick_reply', payload: 'extra-{{first_name}}' }],
    } }, { ...unit, first_name: 'pablo$&' })
    expect(result.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'nombre' }, { type: 'text', text: 'Pablo$&' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'extra-pablo$&' }] },
    ])
  })

  it('uses text parameters for URL buttons and payload parameters for quick replies', () => {
    const result = buildTemplatePayload({ ...campaign, template_params: {
      body: ['Hola {{first_name}}'], buttons: [
        { index: 0, sub_type: 'url', payload: 'customer-{{phone_number}}' },
        { index: 1, sub_type: 'quick_reply', payload: 'confirm' },
      ],
    } }, unit)
    expect(result.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Hola Ana' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'customer-+5492230000000' }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'confirm' }] },
    ])
  })

  it('does not guess a missing template language', () => {
    expect(() => buildTemplatePayload({ ...campaign, template_language: null }, unit)).toThrow(CloudApiError)
  })

  it('allows an approved matching template without a service window', async () => {
    await expect(sendViaCloud(line, unit.phone_number, templatePayload(), campaign.id)).resolves.toEqual({ messageId: 'wamid.test' })
    expect(mocks.window).not.toHaveBeenCalled()
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("status = 'APROBADA'"),
      ['template-1', line.waba_id, 'greeting', 'es_AR'])
  })

  it('reserves line capacity before a standalone test send', async () => {
    mocks.query.mockImplementation(sql => sql.includes('UPDATE whatsapp_lines wl')
      ? Promise.resolve([{ id: line.id }]) : successfulDb(sql))
    await sendViaCloud(line, unit.phone_number, templatePayload(), undefined, { reserveCapacity: true })
    const reservation = mocks.query.mock.calls.findIndex(([sql]) => sql.includes('UPDATE whatsapp_lines wl'))
    expect(reservation).toBeGreaterThan(-1)
    expect(mocks.query.mock.calls[reservation][0]).toContain('msgs_sent_hour < wl.msg_per_hour')
    expect(mocks.query.mock.invocationCallOrder[reservation]).toBeLessThan(mocks.send.mock.invocationCallOrder[0])
  })

  it('does not send a standalone test when another request takes the last line slot', async () => {
    await expect(sendViaCloud(line, unit.phone_number, templatePayload(), undefined, { reserveCapacity: true }))
      .rejects.toBeInstanceOf(CampaignLineUnavailableError)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('refuses a cached line that was disabled or ran out of quota before sending', async () => {
    mocks.query.mockResolvedValue([])
    await expect(sendViaCloud(line, unit.phone_number, templatePayload())).rejects.toBeInstanceOf(CampaignLineUnavailableError)
    expect(mocks.query.mock.calls[0][0]).toContain('wl.sending_enabled = true')
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('does not send a template using a different WABA', async () => {
    mocks.query.mockResolvedValue([{ waba_id: 'other-waba' }])
    await expect(sendViaCloud(line, unit.phone_number, templatePayload())).rejects.toThrow('WABA')
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('rechecks approval/name/language instead of trusting stale campaign metadata', async () => {
    mocks.query.mockImplementation(sql => sql.includes('SELECT id FROM whatsapp_templates') ? Promise.resolve([]) : successfulDb(sql))
    await expect(sendViaCloud(line, unit.phone_number, templatePayload())).rejects.toThrow('aprobada')
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('enforces opt-out on templates before touching the sender', async () => {
    mocks.optedOut.mockResolvedValue(true)
    await expect(sendViaCloud(line, unit.phone_number, templatePayload())).rejects.toBeInstanceOf(OptOutError)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.rate).not.toHaveBeenCalled()
  })

  it('enforces the service window for free-form images as well as text', async () => {
    mocks.window.mockResolvedValue(null)
    await expect(sendViaCloud(line, unit.phone_number, { kind: 'text', body: 'Hola', mediaUrl: 'https://example.com/image.png' }))
      .rejects.toBeInstanceOf(ConversationWindowError)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('turns a provider timeout into an unknown result instead of a retryable rejection', async () => {
    mocks.send.mockRejectedValue(new Error('fetch failed'))
    await expect(sendViaCloud(line, unit.phone_number, templatePayload())).rejects.toBeInstanceOf(CloudSendOutcomeUnknownError)
  })
})

describe('campaign recipient fences and outcomes', () => {
  it('never calls Meta if the durable queued fence cannot be written', async () => {
    mocks.query.mockImplementation(sql => sql.includes('INSERT INTO whatsapp_messages') ? Promise.reject(new Error('storage unavailable')) : successfulDb(sql))
    expect(await sendOneUnit(campaign.id, line, campaign, 3)).toBe('failed')
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it.each(['sent', 'delivered', 'read'])('reconciles an existing %s fence without sending or incrementing counters', async status => {
    mocks.query.mockImplementation(sql => {
      if (sql.includes('INSERT INTO whatsapp_messages')) return Promise.resolve([])
      if (sql.startsWith('SELECT status, evolution_message_id')) return Promise.resolve([{ status, evolution_message_id: 'wamid.existing' }])
      return successfulDb(sql)
    })
    expect(await sendOneUnit(campaign.id, line, campaign, 3)).toBe('sent')
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('increment_line_counters'))).toBe(false)
  })

  it('does not resend an existing queued fence after a manual retry', async () => {
    mocks.query.mockImplementation(sql => {
      if (sql.includes('INSERT INTO whatsapp_messages')) return Promise.resolve([])
      if (sql.startsWith('SELECT status, evolution_message_id')) return Promise.resolve([{ status: 'queued', evolution_message_id: null }])
      return successfulDb(sql)
    })
    expect(await sendOneUnit(campaign.id, line, campaign, 3)).toBe('failed')
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('[provider-outcome-unknown-no-resend]'))).toBe(true)
  })

  it('leaves the message queued and does not auto-retry when the provider outcome is unknown', async () => {
    mocks.send.mockRejectedValue(new Error('socket hang up'))
    expect(await sendOneUnit(campaign.id, line, campaign, 3)).toBe('failed')
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('[provider-outcome-unknown-no-resend]'))).toBe(true)
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('UPDATE whatsapp_messages') && sql.includes("'failed'"))).toBe(false)
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("SET status       = 'pending'"))).toBe(false)
  })

  it('keeps a disabled-line recipient pending without consuming a send attempt', async () => {
    mocks.query.mockImplementation(sql => sql.includes('SELECT cn.waba_id') ? Promise.resolve([]) : successfulDb(sql))
    expect(await sendOneUnit(campaign.id, line, campaign, 3)).toBe('failed')
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('attempts=GREATEST(attempts-1,0)'))).toBe(true)
  })

  it('does not label Meta error 131026 as an opt-out and closes the queued row', async () => {
    mocks.send.mockRejectedValue(new CloudApiError('Undeliverable', 131026, undefined, undefined, false))
    expect(await sendOneUnit(campaign.id, line, campaign, 3)).toBe('skipped')
    const values = mocks.query.mock.calls.flatMap(([, params]) => params || [])
    expect(values.some(value => typeof value === 'string' && value.includes('[cloud-undeliverable]'))).toBe(true)
    expect(values.some(value => typeof value === 'string' && value.includes('[cloud-opted-out]'))).toBe(false)
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('UPDATE whatsapp_messages') && sql.includes("status='failed'"))).toBe(true)
  })

  it('does not automatically retry a definite non-retryable Meta rejection', async () => {
    mocks.send.mockRejectedValue(new CloudApiError('Template rejected', 132000, undefined, undefined, false))
    expect(await sendOneUnit(campaign.id, line, campaign, 3)).toBe('failed')
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("SET status       = 'pending'"))).toBe(false)
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("SET status       = 'failed'"))).toBe(true)
  })

  it('does not convert a successful provider send into failure when later bookkeeping throws', async () => {
    mocks.updateActivity.mockImplementation(() => { throw new Error('bookkeeping failure') })
    expect(await sendOneUnit(campaign.id, line, campaign, 3)).toBe('sent')
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("SET status       = 'pending'"))).toBe(false)
  })
})

describe('template campaign dispatch selection', () => {
  it('pauses pending customers bound to an unavailable sender without completing or sending elsewhere', async () => {
    mocks.query.mockImplementation(sql => {
      if (sql.startsWith('SELECT status FROM campaigns')) return Promise.resolve([{ status: 'running' }])
      if (sql.includes('FROM whatsapp_lines wl') && sql.includes('remaining_hour')) return Promise.resolve([line])
      if (sql.includes('WITH claimed AS')) return Promise.resolve([])
      if (sql.includes('COUNT(*) FILTER')) return Promise.resolve([{ sent: '0', failed: '0', skipped: '0', pending: '1' }])
      return Promise.resolve([])
    })
    await processMultiLineInBackground(campaign, 'lock')
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("pause_reason='assigned_line_unavailable'"))).toBe(true)
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("status = 'completed'"))).toBe(false)
  })

  it.each(['draft', 'scheduled', 'paused', 'cancelled'])('does not claim or send a %s campaign', async status => {
    mocks.query.mockImplementation(sql => sql.startsWith('SELECT status FROM campaigns') ? Promise.resolve([{ status }]) : Promise.resolve([]))
    await processMultiLineInBackground(campaign, 'lock')
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('WITH claimed AS'))).toBe(false)
  })

  it('pauses before claiming recipients when template ownership metadata is missing', async () => {
    await processMultiLineInBackground({ ...campaign, template_waba_id: null }, 'lock')
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('WITH claimed AS'))).toBe(false)
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("pause_reason = 'config_missing'"))).toBe(true)
  })

  it('dispatches a template only through the line belonging to that WABA', async () => {
    let statusReads = 0
    const unrelated = { ...line, id: 'unrelated-line', waba_id: 'other-waba', phone_number_id: '9876543210' }
    mocks.query.mockImplementation(sql => {
      if (sql.startsWith('SELECT status FROM campaigns')) return Promise.resolve([{ status: statusReads++ === 0 ? 'running' : 'paused' }])
      if (sql.includes('FROM whatsapp_lines wl') && sql.includes('remaining_hour')) return Promise.resolve([unrelated, line])
      if (sql.includes('FROM campaign_recipients') && sql.includes('COUNT(*) FILTER')) return Promise.resolve([{ sent: '1', failed: '0', skipped: '0', pending: '0' }])
      return successfulDb(sql)
    })
    await processMultiLineInBackground(campaign, 'lock')
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send.mock.calls[0][0].phoneNumberId).toBe(line.phone_number_id)
    const claims = mocks.query.mock.calls.filter(([sql]) => sql.includes('WITH claimed AS'))
    expect(claims).toHaveLength(1)
    expect(claims[0][1]).toEqual([campaign.id, line.id])
  })

  it('keeps Cloud pacing within the campaign range without random sleep schedules or hour-long bursts', async () => {
    let reads = 0
    mocks.loadedPersonality.mockReturnValue({ burstiness: 1 })
    mocks.activeNow.mockReturnValue(false)
    mocks.query.mockImplementation(sql => {
      if (sql.startsWith('SELECT status FROM campaigns')) return Promise.resolve([{ status: reads++ === 0 ? 'running' : 'paused' }])
      if (sql.includes('FROM whatsapp_lines wl') && sql.includes('remaining_hour')) return Promise.resolve([{ ...line, has_personality: true }])
      return successfulDb(sql)
    })
    await processMultiLineInBackground({ ...campaign, antiblock_delay_min: 3, antiblock_delay_max: 8 }, 'lock')
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.personality).not.toHaveBeenCalled()
    expect(mocks.activeNow).not.toHaveBeenCalled()
    expect(mocks.updateActivity).not.toHaveBeenCalled()
    expect(mocks.delay).toHaveBeenCalledWith(expect.objectContaining({ minSeconds: 3, maxSeconds: 8, burstProbability: 0, microJitterMs: { min: 0, max: 0 } }), expect.any(AbortSignal))
  })
})
