// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), scope: vi.fn(), query: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth }))
vi.mock('@/lib/conversation-access', () => ({ requireConversation: mocks.scope }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
import { POST } from '@/app/api/conversations/[phone]/contact/route'

const phone = '5491100000001'
const context = { params: Promise.resolve({ phone }) }
const request = (body: unknown) => new NextRequest(`https://panel.test/api/conversations/${phone}/contact?agent=all`, { method: 'POST', body: JSON.stringify(body) })
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ ok: true, user: { user_id: 'operator', role: 'operator' } })
})

describe('Conversation contact creation boundary', () => {
  it.each([401, 403])('returns a %s permission denial before accessing contacts', async status => {
    mocks.auth.mockResolvedValue({ ok: false, response: Response.json({ error: 'Sin permiso' }, { status }) })
    expect((await POST(request({ name: 'Ana' }), context)).status).toBe(status)
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), 'conversations', 'update')
    expect(mocks.scope).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
  })
  it.each([null, {}, { name: 12 }, { name: ' ' }, { name: 'a'.repeat(101) }])('rejects an invalid name: %j', async body => {
    expect((await POST(request(body), context)).status).toBe(400)
    expect(mocks.query).not.toHaveBeenCalled()
  })
  it('rejects a forged conversation scope before inserting', async () => {
    mocks.scope.mockRejectedValue(Response.json({ error: 'Sin acceso' }, { status: 403 }))
    expect((await POST(request({ name: 'Ana' }), context)).status).toBe(403)
    expect(mocks.query).not.toHaveBeenCalled()
  })
})
