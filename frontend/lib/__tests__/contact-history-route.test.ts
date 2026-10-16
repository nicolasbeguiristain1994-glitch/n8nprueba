// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
const mocks = vi.hoisted(() => ({ read: vi.fn(), history: vi.fn(), auth: vi.fn() }))
vi.mock('@/lib/contact-read', () => ({ contactRead: mocks.read, ContactReadUnavailableError: class extends Error {} }))
vi.mock('@/lib/contact-history', () => ({ readContactHistory: mocks.history }))
vi.mock('@/lib/db', () => ({ query: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth }))
import { GET } from '@/app/api/contacts/history/route'
const first = '11111111-1111-4111-8111-111111111111'
const second = '22222222-2222-4222-8222-222222222222'
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ ok: true, user: { role: 'operator', user_id: 'operator-1', allowed_agents: ['royal'] } })
  mocks.read.mockResolvedValue([{ id: first, phone_number: '+5491111111111' }])
  mocks.history.mockResolvedValue([{ id: first, days_since_last_movement: 10 }])
})
describe('Contact page history', () => {
  it('resolves only authorized IDs and does not expose inaccessible or deleted contacts', async () => {
    const response = await GET(new NextRequest(`http://localhost/api/contacts/history?ids=${first},${second}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.read.mock.calls[0][0]).toContain('contacts.deleted_at IS NULL')
    expect(mocks.read.mock.calls[0][0]).toContain('operator_contact_visibility')
    expect(mocks.read.mock.calls[0][1]).toEqual([[first,second], 'operator-1', ['royal']])
    expect(mocks.history).toHaveBeenCalledWith([{ id: first, phone_number: '+5491111111111' }], undefined, true)
    expect((await response.json()).history).toEqual([{ id: first, days_since_last_movement: 10 }])
  })
  it('skips movement enrichment already returned by an inactivity filter', async () => {
    await GET(new NextRequest(`http://localhost/api/contacts/history?ids=${first}&fields=broadcast`))
    expect(mocks.history.mock.calls[0][2]).toBe(false)
  })
  it.each(['', 'ids=invalid', 'ids='+Array(51).fill(first).join(','), `ids=${first}&fields=private`])('rejects invalid or unbounded requests: %s', async query => {
    expect((await GET(new NextRequest('http://localhost/api/contacts/history?'+query))).status).toBe(400)
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('requires permission before querying contacts', async () => {
    mocks.auth.mockResolvedValue({ ok:false, response: NextResponse.json({error:'denied'},{status:403}) })
    expect((await GET(new NextRequest(`http://localhost/api/contacts/history?ids=${first}`))).status).toBe(403)
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
