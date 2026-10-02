// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), transaction: vi.fn(), query: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/db', () => ({ withTransaction: mocks.transaction }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth }))
vi.mock('@/lib/audit', () => ({ audit: mocks.audit }))
import { DELETE } from '@/app/api/campaigns/[id]/freq-reset/route'

const id = '11111111-1111-4111-8111-111111111111'
const admin = { user_id: '22222222-2222-4222-8222-222222222222', role: 'admin' }
const recipient = { status: 'failed', locked_at: null, evolution_message_id: null, error_detail: 'definite rejection' }
const message = { status: 'failed', evolution_message_id: null, error_detail: 'definite rejection' }
function invoke(body: unknown = { confirm_reset: true }) {
  return DELETE(new Request(`http://localhost/api/campaigns/${id}/freq-reset`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) })
}
function fixture(options: { status?: string; hasLock?: boolean; recipients?: object[]; messages?: object[]; history?: boolean } = {}) {
  mocks.query.mockResolvedValueOnce({ rows: [{ status: options.status ?? 'paused', has_lock: options.hasLock ?? false }] })
    .mockResolvedValueOnce({ rows: options.recipients ?? [recipient] })
    .mockResolvedValueOnce({ rows: options.messages ?? [message] })
    .mockResolvedValueOnce({ rows: [{ exists: options.history ?? false }] })
    .mockResolvedValueOnce({ rows: [{ count: '1' }] })
    .mockResolvedValueOnce({ rows: [] })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ ok: true, user: admin })
  mocks.transaction.mockImplementation(fn => fn({ query: mocks.query }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())
function expectNoWrites() {
  expect(mocks.query.mock.calls.some(([sql]) => /\b(?:UPDATE campaign|DELETE FROM)/.test(sql))).toBe(false)
  expect(mocks.audit).not.toHaveBeenCalled()
}

describe('legacy campaign reset authorization and state guards', () => {
  it('requires admin even when the permission check succeeds', async () => {
    mocks.auth.mockResolvedValueOnce({ ok: true, user: { ...admin, role: 'operator' } })
    expect((await invoke()).status).toBe(403)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it.each([null, {}, { confirm_reset: false }, { confirm_reset: 'true' }, { confirm_resend_all: true }])(
    'requires the explicit confirm_reset boolean: %j', async body => {
      expect((await invoke(body)).status).toBe(400)
      expect(mocks.transaction).not.toHaveBeenCalled()
    })
  it.each(['running', 'scheduled', 'draft'])('does not reset %s', async status => {
    fixture({ status })
    expect((await invoke()).status).toBe(409)
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expectNoWrites()
  })
  it.each(['paused', 'completed', 'cancelled'])('does not reset a locked %s campaign', async status => {
    fixture({ status, hasLock: true })
    expect((await invoke()).status).toBe(409)
    expectNoWrites()
  })
  it('rejects a missing campaign without writes', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] })
    expect((await invoke()).status).toBe(404)
    expectNoWrites()
  })
  it.each([{ ...recipient, status: 'sending' }, { ...recipient, locked_at: 'synthetic-lock-time' }])(
    'rejects a recipient still being processed', async row => {
      fixture({ recipients: [row] })
      expect((await invoke()).status).toBe(409)
      expect(mocks.query).toHaveBeenCalledTimes(2)
      expectNoWrites()
    })
})

describe('acceptance and ambiguity evidence is immutable during reset', () => {
  it.each([
    { ...message, status: 'queued' }, { ...message, status: 'sent' },
    { ...message, status: 'delivered' }, { ...message, status: 'read' },
    { ...message, evolution_message_id: 'old-provider-id' },
    { ...message, error_detail: '[provider-outcome-unknown-no-resend] timeout' },
    { ...message, error_detail: 'stale-queued-no-resend timeout' },
  ])('blocks existing provider evidence %j even with explicit confirmation', async row => {
    fixture({ messages: [row] })
    const response = await invoke()
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('campaña nueva')
    expectNoWrites()
  })
  it.each([
    { ...recipient, status: 'sent' }, { ...recipient, evolution_message_id: 'accepted-id' },
    { ...recipient, error_detail: '[provider-outcome-unknown-no-resend] timeout' },
    { ...recipient, error_detail: 'stale-queued-no-resend timeout' },
  ])('blocks accepted or ambiguous recipient evidence %j', async row => {
    fixture({ recipients: [row], messages: [] })
    expect((await invoke()).status).toBe(409)
    expectNoWrites()
  })
  it('preserves history even if the message record is missing', async () => {
    fixture({ history: true, messages: [] })
    expect((await invoke()).status).toBe(409)
    expectNoWrites()
    const sql = mocks.query.mock.calls[3][0]
    expect(sql).toContain('contact_send_history WHERE campaign_id = $1')
    expect(sql).not.toContain('contact_id IN')
  })
})

describe('definite failures reset atomically without removing logs', () => {
  it.each(['paused', 'completed', 'cancelled'])('resets an unlocked %s campaign under the same transaction', async status => {
    fixture({ status })
    const response = await invoke()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, deleted_history: 0, reset_recipients: 1 })
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.query.mock.calls[0][0]).toContain('FOR UPDATE')
    expect(mocks.query.mock.calls[1][0]).toContain('FOR UPDATE')
    expect(mocks.query.mock.calls[2][0]).toContain('FOR UPDATE')
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM'))).toBe(false)
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('UPDATE whatsapp_messages'))).toBe(false)
    expect(mocks.query.mock.calls[4][0]).not.toContain('evolution_message_id = NULL')
    expect(mocks.query.mock.calls[5][1]).toEqual([id, admin.user_id])
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ accepted_fences_preserved: true }) }))
  })
  it('propagates a write failure to the transaction and does not report success', async () => {
    let rejection: unknown
    mocks.transaction.mockImplementation(async fn => {
      try { return await fn({ query: mocks.query }) } catch (error) { rejection = error; throw error }
    })
    mocks.query.mockResolvedValueOnce({ rows: [{ status: 'paused', has_lock: false }] })
      .mockResolvedValueOnce({ rows: [recipient] }).mockResolvedValueOnce({ rows: [message] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] }).mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockRejectedValueOnce(new Error('synthetic update failed'))
    expect((await invoke()).status).toBe(500)
    expect(rejection).toBeInstanceOf(Error)
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it('history lookup failure does not silently authorize a reset', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ status: 'paused', has_lock: false }] })
      .mockResolvedValueOnce({ rows: [recipient] }).mockResolvedValueOnce({ rows: [message] })
      .mockRejectedValueOnce(new Error('synthetic history read failed'))
    expect((await invoke()).status).toBe(500)
    expectNoWrites()
  })
})
