/**
 * send-processor unit tests
 *
 * Covers:
 *  1. syncCounters — includes skipped, writes total_sent/failed/skipped
 *  2. Frequency gate — BLOCK → skipped, error → continues sending
 *  3. n8n failures — HTTP 500 → failed, timeout → failed
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

// ── Factories ─────────────────────────────────────────────────────────────────

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id:                  'campaign-uuid',
    name:                'Test Campaign',
    message:             'Hola {{nombre}}',
    messages:            null,
    media_url:           '',
    list_id:             'list-uuid',
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
    phone_number: '+5491100000001',
    first_name:   'Juan',
    attempts:     1,
    ...overrides,
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

    await processInBackground(campaign, 'http://n8n:5678', 'lock-token')

    // The UPDATE that marks the recipient as skipped should have been called
    const queries = vi.mocked(db.query).mock.calls.map(c => String(c[0]))
    const skippedUpdate = queries.find(q => q.includes("SET status = 'skipped'"))
    expect(skippedUpdate).toBeDefined()
  })

  it('continues sending when frequency engine throws an error', async () => {
    const campaign = makeCampaign()
    const recipient = makeRecipient()

    vi.mocked(ContactFrequencyEngine.atomicEvaluateAndRecord)
      .mockRejectedValue(new Error('DB connection lost'))

    vi.mocked(db.query)
      // recoverStaleRows
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
      // status gate
      .mockResolvedValueOnce([{ status: 'running' }])
      // claimOne
      .mockResolvedValueOnce([recipient])
      // sendOne: pre-insert queued
      .mockResolvedValueOnce([])
      // sendOne n8n is mocked via global fetch below — we stub it to return ok
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

    // Mock global fetch for n8n call
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'msg-id' }),
    } as Response)

    await processInBackground(campaign, 'http://n8n:5678', 'lock-token')

    // Verify recipient was NOT marked as skipped (freq error → continue)
    // "SET status = 'skipped'" only appears in the BLOCK update, not in syncCounters FILTERs
    const queries = vi.mocked(db.query).mock.calls.map(c => String(c[0]))
    const skippedUpdate = queries.find(q => q.includes("SET status = 'skipped'"))
    expect(skippedUpdate).toBeUndefined()
  })
})

// ── n8n error handling ────────────────────────────────────────────────────────

describe('sendOne — n8n error handling', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns failed and records error on HTTP 500', async () => {
    const campaign = makeCampaign()
    const recipient = makeRecipient()

    vi.mocked(db.query)
      .mockResolvedValue([])  // pre-insert + failure inserts

    global.fetch = vi.fn().mockResolvedValue({
      ok:     false,
      status: 500,
      json:   async () => ({ message: 'Internal Server Error' }),
    } as Response)

    const result = await sendOne('campaign-uuid', campaign, recipient, 'http://n8n:5678')
    expect(result).toBe('failed')

    // Verify failure was recorded in campaign_recipients
    const queries = vi.mocked(db.query).mock.calls.map(c => String(c[0]))
    const failedUpdate = queries.find(q =>
      q.includes("status = 'failed'") && q.includes('campaign_recipients')
    )
    expect(failedUpdate).toBeDefined()
  })

  it('returns failed and records error on network timeout', async () => {
    const campaign = makeCampaign()
    const recipient = makeRecipient()

    vi.mocked(db.query).mockResolvedValue([])

    global.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
    )

    const result = await sendOne('campaign-uuid', campaign, recipient, 'http://n8n:5678')
    expect(result).toBe('failed')

    const queries = vi.mocked(db.query).mock.calls.map(c => String(c[0]))
    const failedUpdate = queries.find(q =>
      q.includes("status = 'failed'") && q.includes('campaign_recipients')
    )
    expect(failedUpdate).toBeDefined()
  })

  it('returns sent on HTTP 200', async () => {
    const campaign = makeCampaign()
    const recipient = makeRecipient()

    vi.mocked(db.query).mockResolvedValue([])

    global.fetch = vi.fn().mockResolvedValue({
      ok:   true,
      json: async () => ({ id: 'evo-msg-id' }),
    } as Response)

    const result = await sendOne('campaign-uuid', campaign, recipient, 'http://n8n:5678')
    expect(result).toBe('sent')
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

    // All blocked
    blockDecision('max_per_week exceeded')

    let recipientIdx = 0
    vi.mocked(db.query).mockImplementation(async (sql: unknown) => {
      const s = String(sql)
      // recoverStaleRows
      if (s.includes('INTERVAL') && s.includes("'sending'")) return []
      // status gate
      if (s.includes('SELECT status FROM campaigns')) return [{ status: 'running' }]
      // claimOne — return next recipient or empty
      if (s.includes('FOR UPDATE SKIP LOCKED')) {
        return recipientIdx < recipients.length ? [recipients[recipientIdx++]] : []
      }
      // skipped update
      if (s.includes("status = 'skipped'")) return []
      // syncCounters SELECT
      if (s.includes('COUNT(*) FILTER') && s.includes('campaign_recipients')) {
        const done = recipientIdx
        const remaining = recipients.length - done
        return [{ sent: '0', failed: '0', skipped: String(done), pending: String(remaining) }]
      }
      // syncCounters UPDATE / completion UPDATE / release lock
      return []
    })

    await processInBackground(campaign, 'http://n8n:5678', 'lock-token')

    const queries = vi.mocked(db.query).mock.calls.map(c => String(c[0]))
    const completedUpdate = queries.find(q =>
      q.includes("status = 'completed'") && q.includes('UPDATE campaigns')
    )
    expect(completedUpdate).toBeDefined()
  })
})

// ── Counter consistency ───────────────────────────────────────────────────────

describe('counter consistency', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('pending=0 triggers loop exit regardless of sent/failed/skipped split', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce([{ sent: '3', failed: '1', skipped: '2', pending: '0' }])
      .mockResolvedValueOnce([])

    const result = await syncCounters('cid')
    expect(result.pending).toBe(0)
    expect(result.sent + result.failed + result.skipped).toBe(6)
  })

  it('skipped recipients do NOT count as pending', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce([{ sent: '0', failed: '0', skipped: '5', pending: '0' }])
      .mockResolvedValueOnce([])

    const { pending } = await syncCounters('cid')
    expect(pending).toBe(0)
  })
})
