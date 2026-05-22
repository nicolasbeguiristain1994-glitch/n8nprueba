/**
 * send-processor unit tests
 * @vitest-environment node
 *
 * Covers:
 *  1. syncCounters — includes skipped, writes total_sent/failed/skipped
 *  2. Frequency gate — BLOCK → skipped, error → continues sending
 *  3. Evolution failures — throws → failed, success → sent
 *  4. All-skipped campaign → completes (pending drops to 0)
 *  5. Counter consistency — pending=0 after all recipients processed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  syncCounters,
  sendOne,
  processInBackground,
  type CampaignRow,
  type RecipientRow,
} from '@/lib/send-processor'

// ── Mock DB ──────────────────────────────────────────────────────────────────
vi.mock('@/lib/db', () => ({
  query: vi.fn(),
}))
import * as db from '@/lib/db'

// ── Mock ContactFrequencyEngine ───────────────────────────────────────────────
vi.mock('@/lib/contact-frequency/ContactFrequencyEngine', () => ({
  ContactFrequencyEngine: {
    atomicEvaluateAndRecord: vi.fn(),
  },
}))
import { ContactFrequencyEngine } from '@/lib/contact-frequency/ContactFrequencyEngine'

// ── Mock campaign-distributor ─────────────────────────────────────────────────
// sendOne now calls getEligibleLines + sendViaEvolution directly (no N8N)
vi.mock('@/lib/campaign-distributor', () => ({
  getEligibleLines: vi.fn(),
  sendViaEvolution: vi.fn(),
}))
import { getEligibleLines, sendViaEvolution } from '@/lib/campaign-distributor'

// ── Factories ─────────────────────────────────────────────────────────────────

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id:                  'campaign-uuid',
    name:                'Test Campaign',
    message:             'Hola {{nombre}}',
    messages:            null,
    media_url:           '',
    list_id:             'list-uuid',
    prospect_list_id:    null,
    antiblock_delay_min: 0,
    antiblock_delay_max: 0,
    personalize_name:    true,
    status:              'running',
    owned_by:            'operator-uuid',
    ...overrides,
  }
}

function makeRecipient(overrides: Partial<RecipientRow> = {}): RecipientRow {
  return {
    id:           'rec-uuid-1',
    contact_id:   'contact-uuid-1',
    prospect_id:  null,
    phone_number: '+5491100000001',
    first_name:   'Juan',
    attempts:     1,
    ...overrides,
  }
}

function makeEligibleLine() {
  return {
    id: 'line-uuid-1',
    evolution_instance: 'wa-instance-01',
    evolution_url: 'https://evo.example.com',
    msgs_sent_hour: 0,
    msgs_sent_today: 0,
    msg_per_hour: 50,
    msg_per_day: 500,
  }
}

function allowDecision() {
  vi.mocked(ContactFrequencyEngine.atomicEvaluateAndRecord).mockResolvedValue({
    decision: 'ALLOW', reason: '', riskScore: 0,
  } as never)
}

function blockDecision(reason = 'max_per_day exceeded') {
  vi.mocked(ContactFrequencyEngine.atomicEvaluateAndRecord).mockResolvedValue({
    decision: 'BLOCK', reason, riskScore: 100,
  } as never)
}

// ── syncCounters ──────────────────────────────────────────────────────────────

describe('syncCounters', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('maps sent/failed/skipped/pending from DB strings to numbers', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce([{ sent: '10', failed: '2', skipped: '3', pending: '5' }])
      .mockResolvedValueOnce([])  // UPDATE campaigns

    const result = await syncCounters('campaign-uuid')
    expect(result).toEqual({ sent: 10, failed: 2, skipped: 3, pending: 5 })
  })

  it('writes total_sent, total_failed AND total_skipped to campaigns table', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce([{ sent: '5', failed: '1', skipped: '4', pending: '0' }])
      .mockResolvedValueOnce([])

    await syncCounters('campaign-uuid')

    const updateCall = vi.mocked(db.query).mock.calls[1]
    expect(updateCall[0]).toContain('total_skipped')
    expect(updateCall[1]).toEqual([5, 1, 4, 'campaign-uuid'])
  })

  it('treats missing row values as zero', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([])

    const result = await syncCounters('campaign-uuid')
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 0, pending: 0 })
  })
})

// ── Frequency gate — BLOCK → skipped ─────────────────────────────────────────

describe('frequency gate in processInBackground', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('marks recipient as skipped when frequency engine returns BLOCK', async () => {
    const campaign = makeCampaign()
    const recipient = makeRecipient()

    vi.mocked(db.query)
      // recoverStaleRows (3 queries)
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
      // status gate → running
      .mockResolvedValueOnce([{ status: 'running' }])
      // claimOne → returns recipient
      .mockResolvedValueOnce([recipient])
      // UPDATE campaign_recipients → skipped
      .mockResolvedValueOnce([])
      // syncCounters SELECT
      .mockResolvedValueOnce([{ sent: '0', failed: '0', skipped: '1', pending: '0' }])
      // syncCounters UPDATE
      .mockResolvedValueOnce([])
      // final syncCounters SELECT
      .mockResolvedValueOnce([{ sent: '0', failed: '0', skipped: '1', pending: '0' }])
      // final syncCounters UPDATE
      .mockResolvedValueOnce([])
      // SELECT status (completion check)
      .mockResolvedValueOnce([{ status: 'running' }])
      // UPDATE campaigns → completed
      .mockResolvedValueOnce([])
      // finally: release lock
      .mockResolvedValueOnce([])

    blockDecision('max_per_day exceeded')

    await processInBackground(campaign, 'lock-token')

    const queries = vi.mocked(db.query).mock.calls.map(c => String(c[0]))
    const skippedUpdate = queries.find(q => q.includes("SET status = 'skipped'"))
    expect(skippedUpdate).toBeDefined()
  })

  it('continues sending when frequency engine throws an error', async () => {
    const campaign = makeCampaign()
    const recipient = makeRecipient()

    vi.mocked(ContactFrequencyEngine.atomicEvaluateAndRecord)
      .mockRejectedValue(new Error('DB connection lost'))

    vi.mocked(getEligibleLines).mockResolvedValue([makeEligibleLine()] as never)
    vi.mocked(sendViaEvolution).mockResolvedValue({ messageId: 'evo-msg-id' })

    vi.mocked(db.query)
      // recoverStaleRows
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
      // status gate
      .mockResolvedValueOnce([{ status: 'running' }])
      // claimOne
      .mockResolvedValueOnce([recipient])
      // sendOne: pre-insert queued
      .mockResolvedValueOnce([])
      // sendOne: UPDATE line counters
      .mockResolvedValueOnce([])
      // sendOne: UPDATE whatsapp_messages → sent
      .mockResolvedValueOnce([])
      // sendOne: UPDATE campaign_recipients → sent
      .mockResolvedValueOnce([])
      // syncCounters SELECT
      .mockResolvedValueOnce([{ sent: '1', failed: '0', skipped: '0', pending: '0' }])
      // syncCounters UPDATE
      .mockResolvedValueOnce([])
      // final syncCounters SELECT
      .mockResolvedValueOnce([{ sent: '1', failed: '0', skipped: '0', pending: '0' }])
      // final syncCounters UPDATE
      .mockResolvedValueOnce([])
      // SELECT status
      .mockResolvedValueOnce([{ status: 'running' }])
      // UPDATE completed
      .mockResolvedValueOnce([])
      // release lock
      .mockResolvedValueOnce([])

    await processInBackground(campaign, 'lock-token')

    const queries = vi.mocked(db.query).mock.calls.map(c => String(c[0]))
    const skippedUpdate = queries.find(q => q.includes("SET status = 'skipped'"))
    expect(skippedUpdate).toBeUndefined()
  })
})

// ── Evolution error handling ──────────────────────────────────────────────────

describe('sendOne — Evolution error handling', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns failed and records error when Evolution throws', async () => {
    const campaign = makeCampaign()
    const recipient = makeRecipient()

    vi.mocked(getEligibleLines).mockResolvedValue([makeEligibleLine()] as never)
    vi.mocked(sendViaEvolution).mockRejectedValue(new Error('Evolution 500: Internal Server Error'))

    vi.mocked(db.query).mockResolvedValue([])

    const result = await sendOne('campaign-uuid', campaign, recipient)
    expect(result).toBe('failed')

    const queries = vi.mocked(db.query).mock.calls.map(c => String(c[0]))
    const failedUpdate = queries.find(q =>
      q.includes("status = 'failed'") && q.includes('campaign_recipients')
    )
    expect(failedUpdate).toBeDefined()
  })

  it('returns failed when no eligible lines', async () => {
    const campaign = makeCampaign()
    const recipient = makeRecipient()

    vi.mocked(getEligibleLines).mockResolvedValue([] as never)
    vi.mocked(db.query).mockResolvedValue([])

    const result = await sendOne('campaign-uuid', campaign, recipient)
    expect(result).toBe('failed')
  })

  it('returns sent and records messageId on Evolution success', async () => {
    const campaign = makeCampaign()
    const recipient = makeRecipient()

    vi.mocked(getEligibleLines).mockResolvedValue([makeEligibleLine()] as never)
    vi.mocked(sendViaEvolution).mockResolvedValue({ messageId: 'evo-msg-id-123' })

    vi.mocked(db.query).mockResolvedValue([])

    const result = await sendOne('campaign-uuid', campaign, recipient)
    expect(result).toBe('sent')

    // Verify messageId was stored in campaign_recipients update
    const recipientUpdate = vi.mocked(db.query).mock.calls.find(c =>
      String(c[0]).includes('evolution_message_id') && String(c[0]).includes('campaign_recipients')
    )
    expect(recipientUpdate).toBeDefined()
    expect(recipientUpdate![1]).toContain('evo-msg-id-123')
  })
})

// ── All-skipped → campaign completes ─────────────────────────────────────────

describe('all-skipped campaign completion', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('marks campaign as completed when all recipients are blocked by frequency', async () => {
    const campaign = makeCampaign()
    const recipients = [
      makeRecipient({ id: 'rec-1', contact_id: 'c-1' }),
      makeRecipient({ id: 'rec-2', contact_id: 'c-2' }),
    ]

    blockDecision('max_per_week exceeded')

    let recipientIdx = 0
    vi.mocked(db.query).mockImplementation(async (sql: unknown) => {
      const s = String(sql)
      if (s.includes('INTERVAL') && s.includes("'sending'")) return []
      if (s.includes('SELECT status FROM campaigns')) return [{ status: 'running' }]
      if (s.includes('FOR UPDATE SKIP LOCKED')) {
        return recipientIdx < recipients.length ? [recipients[recipientIdx++]] : []
      }
      if (s.includes("status = 'skipped'")) return []
      if (s.includes('COUNT(*) FILTER') && s.includes('campaign_recipients')) {
        const done = recipientIdx
        const remaining = recipients.length - done
        return [{ sent: '0', failed: '0', skipped: String(done), pending: String(remaining) }]
      }
      return []
    })

    await processInBackground(campaign, 'lock-token')

    const queries = vi.mocked(db.query).mock.calls.map(c => String(c[0]))
    const completedUpdate = queries.find(q =>
      q.includes("status = 'completed'") && q.includes('UPDATE campaigns')
    )
    expect(completedUpdate).toBeDefined()
  })
})
