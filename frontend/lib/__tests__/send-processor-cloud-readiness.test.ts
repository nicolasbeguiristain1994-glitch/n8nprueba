/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { query } from '@/lib/db'
import {
  buildTemplatePayload, CampaignLineUnavailableError, CloudSendOutcomeUnknownError,
  getEligibleLines, sendViaCloud, sendViaEvolution, type EligibleLine,
} from '@/lib/campaign-distributor'
import { ConversationWindowError, OptOutError } from '@/lib/cloud-api/errors'
import { sendOne, processInBackground, type CampaignRow, type RecipientRow } from '@/lib/send-processor'

vi.mock('@/lib/db', () => ({ query: vi.fn() }))
// Routing has its own PostgreSQL suite; this adapter test must not enter a real transaction.
vi.mock('@/lib/campaign-routing', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/campaign-routing')>(),
  prepareCampaignRouting: vi.fn(async () => {}),
  getCampaignAssignedLine: vi.fn(async () => 'cloud-line'),
}))
vi.mock('@/lib/campaign-logger', () => ({ clog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/contact-frequency/ContactFrequencyEngine', () => ({
  ContactFrequencyEngine: { atomicEvaluateAndRecord: vi.fn() },
}))
vi.mock('@/lib/campaign-distributor', () => ({
  getEligibleLines: vi.fn(), sendViaCloud: vi.fn(), sendViaEvolution: vi.fn(),
  buildTemplatePayload: vi.fn(),
  CampaignLineUnavailableError: class extends Error {},
  CloudSendOutcomeUnknownError: class extends Error {},
}))

const campaign: CampaignRow = {
  id: 'campaign', name: 'Cloud campaign', message: 'Hola {{nombre}}', messages: null,
  media_url: '', list_id: 'list', prospect_list_id: null,
  antiblock_delay_min: 0, antiblock_delay_max: 0, personalize_name: true,
  status: 'running', owned_by: 'operator', message_type: 'text',
}
const recipient: RecipientRow = {
  id: 'recipient', contact_id: 'contact', prospect_id: null,
  phone_number: '+5491100000001', first_name: 'Ana', attempts: 1,
}
const line: EligibleLine = {
  id: 'cloud-line', line_type: 'cloud', phone_number_id: 'meta-number', waba_id: 'waba',
  evolution_instance: null, evolution_url: null, msgs_sent_hour: 0, msgs_sent_today: 0,
  msg_per_hour: 50, msg_per_day: 500, priority: 1, last_seen_at: null,
  remaining_hour: 50, remaining_day: 500, has_personality: false,
}
const templateCampaign: CampaignRow = {
  ...campaign, message_type: 'template', template_id: 'template', template_name: 'welcome',
  template_language: 'es_AR', template_status: 'APROBADA', template_waba_id: 'waba',
  template_params: { body: ['{{first_name}}'] },
}
const templateContent = { name: 'welcome', language: { code: 'es_AR' }, components: [] }

function isFence(sql: string) {
  return sql.includes('INSERT INTO whatsapp_messages') && sql.includes('RETURNING id')
}
function successfulDatabase(sql: string) {
  return isFence(sql) ? [{ id: 'message' }] : []
}
function statements() { return vi.mocked(query).mock.calls.map(([sql]) => sql) }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(query).mockImplementation(async sql => successfulDatabase(sql))
  vi.mocked(getEligibleLines).mockResolvedValue([line])
  vi.mocked(sendViaCloud).mockResolvedValue({ messageId: 'wamid.123' })
  vi.mocked(buildTemplatePayload).mockReturnValue(templateContent)
})

describe('single-line Cloud campaign readiness', () => {
  it('sends Cloud text through the guarded Cloud adapter using owner-scoped lines', async () => {
    await expect(sendOne(campaign.id, campaign, recipient)).resolves.toBe('sent')
    expect(getEligibleLines).toHaveBeenCalledWith('operator')
    expect(sendViaCloud).toHaveBeenCalledWith(line, recipient.phone_number,
      { kind: 'text', body: 'Hola Ana', mediaUrl: null }, campaign.id)
    expect(sendViaEvolution).not.toHaveBeenCalled()
    const assignment = vi.mocked(query).mock.calls.find(([sql]) => sql.includes('SET line_id = $1'))
    expect(assignment?.[1]).toEqual([line.id, recipient.id])
    expect(statements().filter(sql => sql.includes('increment_line_counters'))).toHaveLength(1)
  })

  it('retains the Cloud media payload and exact template language and WABA', async () => {
    await sendOne(campaign.id, { ...campaign, media_url: 'https://example.test/image.png' }, recipient)
    expect(sendViaCloud).toHaveBeenLastCalledWith(line, recipient.phone_number,
      { kind: 'text', body: 'Hola Ana', mediaUrl: 'https://example.test/image.png' }, campaign.id)
    vi.mocked(getEligibleLines).mockResolvedValue([
      { ...line, id: 'evolution', line_type: 'evolution' },
      { ...line, id: 'other-waba', waba_id: 'another-waba' }, line,
    ])
    await expect(sendOne(campaign.id, templateCampaign, recipient)).resolves.toBe('sent')
    expect(buildTemplatePayload).toHaveBeenCalledWith({
      template_name: 'welcome', template_language: 'es_AR', template_params: { body: ['{{first_name}}'] },
    }, recipient)
    expect(sendViaCloud).toHaveBeenLastCalledWith(line, recipient.phone_number, {
      kind: 'template', content: templateContent, wabaId: 'waba', templateId: 'template',
    }, campaign.id)
    expect(sendViaEvolution).not.toHaveBeenCalled()
  })

  it.each(['PAUSADA', 'PENDIENTE', 'APPROVED', undefined])('blocks an unapproved or incomplete template (%s)', async status => {
    await expect(sendOne(campaign.id, { ...templateCampaign, template_status: status }, recipient))
      .resolves.toBe('failed')
    expect(sendViaCloud).not.toHaveBeenCalled()
    expect(sendViaEvolution).not.toHaveBeenCalled()
    expect(statements().some(sql => sql.includes('whatsapp_messages'))).toBe(false)
  })

  it('requires the approved template language without guessing a fallback', async () => {
    await expect(sendOne(campaign.id, { ...templateCampaign, template_language: null }, recipient))
      .resolves.toBe('failed')
    expect(sendViaCloud).not.toHaveBeenCalled()
    expect(buildTemplatePayload).not.toHaveBeenCalled()
  })

  it('never falls back to Evolution or another WABA for a template', async () => {
    vi.mocked(getEligibleLines).mockResolvedValue([
      { ...line, line_type: 'evolution' }, { ...line, waba_id: 'different' },
    ])
    await expect(sendOne(campaign.id, templateCampaign, recipient)).resolves.toBe('deferred')
    expect(sendViaCloud).not.toHaveBeenCalled()
    expect(sendViaEvolution).not.toHaveBeenCalled()
  })

  it('preserves pending recipients and existing message fences when all lines are unavailable', async () => {
    vi.mocked(getEligibleLines).mockResolvedValue([])
    await expect(sendOne(campaign.id, campaign, recipient)).resolves.toBe('deferred')
    expect(statements().some(sql => sql.includes("SET status = 'pending'") && sql.includes('attempts - 1'))).toBe(true)
    expect(statements().some(sql => sql.includes('whatsapp_messages'))).toBe(false)
    expect(sendViaCloud).not.toHaveBeenCalled()
    expect(sendViaEvolution).not.toHaveBeenCalled()
  })

  it.each([new OptOutError(recipient.phone_number), new ConversationWindowError()])(
    'counts a Cloud compliance rejection as skipped: %s', async error => {
      vi.mocked(sendViaCloud).mockRejectedValue(error)
      await expect(sendOne(campaign.id, campaign, recipient)).resolves.toBe('skipped')
      expect(statements().some(sql => sql.includes("SET status = 'skipped'"))).toBe(true)
      expect(statements().some(sql => sql.includes('increment_line_counters'))).toBe(false)
      expect(sendViaEvolution).not.toHaveBeenCalled()
    },
  )

  it('restores pending work when a selected Cloud line is disabled before sending', async () => {
    vi.mocked(sendViaCloud).mockRejectedValue(new CampaignLineUnavailableError())
    await expect(sendOne(campaign.id, campaign, recipient)).resolves.toBe('deferred')
    expect(statements().some(sql => sql.includes("SET status = 'pending'") && sql.includes('attempts - 1'))).toBe(true)
    expect(statements().some(sql => sql.includes("error_detail = 'line-unavailable-before-send'"))).toBe(true)
    expect(statements().some(sql => sql.includes('increment_line_counters'))).toBe(false)
  })

  it('pauses after a disabled line so the next loop cannot fail the restored recipient', async () => {
    let status = 'running'
    vi.mocked(sendViaCloud).mockRejectedValue(new CampaignLineUnavailableError())
    vi.mocked(query).mockImplementation(async sql => {
      if (sql.includes('SELECT status FROM campaigns')) return [{ status }]
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return [{ ...recipient, contact_id: null }]
      if (sql.includes('UPDATE campaigns SET status')) status = 'paused'
      if (sql.includes('COUNT(*) FILTER')) return [{ sent: '0', failed: '0', skipped: '0', pending: '1' }]
      return successfulDatabase(sql)
    })
    await processInBackground(campaign, 'lock')
    expect(status).toBe('paused')
    expect(getEligibleLines).toHaveBeenCalledTimes(2)
    expect(statements().some(sql => sql.includes('UPDATE campaign_recipients') && sql.includes("SET status = 'failed'"))).toBe(false)
  })

  it('does not send when the queued message cannot be persisted', async () => {
    vi.mocked(query).mockImplementation(async sql => {
      if (isFence(sql)) throw new Error('storage unavailable')
      return []
    })
    await expect(sendOne(campaign.id, campaign, recipient)).resolves.toBe('failed')
    expect(sendViaCloud).not.toHaveBeenCalled()
    expect(sendViaEvolution).not.toHaveBeenCalled()
  })

  it.each(['sent', 'delivered', 'read'])('reconciles a previous %s fence without sending or counting twice', async status => {
    vi.mocked(query).mockImplementation(async sql =>
      sql.includes('SELECT status, evolution_message_id')
        ? [{ status, evolution_message_id: 'wamid.old' }] : [])
    await expect(sendOne(campaign.id, campaign, recipient)).resolves.toBe('sent')
    expect(sendViaCloud).not.toHaveBeenCalled()
    expect(statements().some(sql => sql.includes('increment_line_counters'))).toBe(false)
    expect(vi.mocked(query).mock.calls.some(([sql, params]) =>
      sql.includes('UPDATE campaign_recipients') && params?.includes('wamid.old'))).toBe(true)
  })

  it('retains queued fences after manual recipient reset and blocks a second send', async () => {
    vi.mocked(query).mockImplementation(async sql =>
      sql.includes('SELECT status, evolution_message_id')
        ? [{ status: 'queued', evolution_message_id: null }] : [])
    await expect(sendOne(campaign.id, campaign, recipient)).resolves.toBe('failed')
    expect(sendViaCloud).not.toHaveBeenCalled()
    expect(statements().some(sql => sql.includes('UPDATE whatsapp_messages'))).toBe(false)
    const fenceSql = statements().find(isFence)!
    expect(fenceSql).toContain("WHERE whatsapp_messages.status = 'failed'")
    expect(fenceSql).toContain('whatsapp_messages.evolution_message_id IS NULL')
    expect(fenceSql).toContain('[provider-outcome-unknown-no-resend]')
  })

  it('does not resend a failed message that already has a provider acknowledgement', async () => {
    vi.mocked(query).mockImplementation(async sql =>
      sql.includes('SELECT status, evolution_message_id')
        ? [{ status: 'failed', evolution_message_id: 'wamid.accepted' }] : [])
    await expect(sendOne(campaign.id, campaign, recipient)).resolves.toBe('failed')
    expect(sendViaCloud).not.toHaveBeenCalled()
    expect(statements().some(sql => sql.includes('increment_line_counters'))).toBe(false)
  })

  it('keeps an unknown Cloud outcome fenced for reconciliation', async () => {
    vi.mocked(sendViaCloud).mockRejectedValue(new CloudSendOutcomeUnknownError())
    await expect(sendOne(campaign.id, campaign, recipient)).resolves.toBe('failed')
    expect(statements().some(sql => sql.includes('UPDATE whatsapp_messages'))).toBe(false)
    expect(statements().some(sql => sql.includes('increment_line_counters'))).toBe(false)
    expect(vi.mocked(query).mock.calls.some(([, params]) =>
      params?.some(value => String(value).includes('[provider-outcome-unknown-no-resend]')))).toBe(true)
  })

  it('never converts provider acceptance into a retryable failure when local writes fail', async () => {
    vi.mocked(query).mockImplementation(async sql => {
      if (isFence(sql)) return [{ id: 'message' }]
      if (sql.includes('UPDATE whatsapp_messages') || sql.includes("SET status = 'sent'")) {
        throw new Error('post-acceptance storage failure')
      }
      return []
    })
    await expect(sendOne(campaign.id, campaign, recipient)).resolves.toBe('sent')
    expect(sendViaCloud).toHaveBeenCalledTimes(1)
    expect(statements().some(sql => sql.includes("SET status = 'failed'"))).toBe(false)
    expect(statements().some(sql => sql.includes("'outbound', 'failed'"))).toBe(false)
  })

  it('does not claim recipients once the campaign is no longer running', async () => {
    vi.mocked(query).mockImplementation(async sql => {
      if (sql.includes('SELECT status FROM campaigns')) return [{ status: 'completed' }]
      if (sql.includes('COUNT(*) FILTER')) return [{ sent: '1', failed: '0', skipped: '0', pending: '1' }]
      return []
    })
    await processInBackground(campaign, 'lock')
    expect(statements().some(sql => sql.includes('FOR UPDATE SKIP LOCKED'))).toBe(false)
    expect(sendViaCloud).not.toHaveBeenCalled()
  })
})
