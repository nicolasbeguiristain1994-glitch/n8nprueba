// @vitest-environment node
import { vi, it, expect, beforeEach, afterEach, describe } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mock = vi.hoisted(() => ({
  auth: vi.fn(), access: vi.fn(), find: vi.fn(), token: vi.fn(), setInbox: vi.fn(),
  query: vi.fn(), ids: vi.fn(),
}))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mock.auth }))
vi.mock('@/lib/cloud-api/access', () => ({ cloudNumberAccess: mock.access }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/cloud-api/repositories/cloud-number.repository', () => ({
  cloudNumberRepository: { findByPhoneNumberId: mock.find, setChatwootInbox: mock.setInbox },
}))
vi.mock('@/lib/cloud-api/token-store', () => ({ getTokenForNumber: mock.token }))
vi.mock('@/lib/db', () => ({ query: mock.query, withTransaction: vi.fn() }))
vi.mock('@/lib/line-visibility', () => ({
  getAccessibleLineIds: mock.ids, lineVisibilityClause: () => ({ clause: '', params: [] }),
}))

import { isChatwootConfigured } from '../cloud-api/chatwoot-config'
import { createChatwootInboxUseCase, ChatwootNotConfiguredError } from '../cloud-api/use-cases/create-chatwoot-inbox.use-case'
import { POST } from '@/app/api/cloud/chatwoot-inbox/route'
import { GET as getLines } from '@/app/api/lines/route'

const DUMMY = { CHATWOOT_API_URL: 'https://chatwoot.test', CHATWOOT_API_KEY: 'dummy-key-123', CHATWOOT_ACCOUNT_ID: '7' }
const stubChatwoot = (v: Partial<typeof DUMMY>) =>
  (Object.keys(DUMMY) as (keyof typeof DUMMY)[]).forEach(k => vi.stubEnv(k, v[k] ?? ''))
const post = (body: unknown) => new NextRequest('http://localhost/api/cloud/chatwoot-inbox', {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
})

let fetchSpy: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.resetAllMocks()
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  mock.auth.mockResolvedValue({ ok: true, user: { user_id: 'u1', role: 'admin' } })
  mock.access.mockResolvedValue(null)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('isChatwootConfigured', () => {
  it('requires all three values, non-blank after trimming', () => {
    expect(isChatwootConfigured({ ...DUMMY })).toBe(true)
    expect(isChatwootConfigured({ ...DUMMY, CHATWOOT_API_KEY: '   ' })).toBe(false)
    expect(isChatwootConfigured({ CHATWOOT_API_URL: DUMMY.CHATWOOT_API_URL, CHATWOOT_API_KEY: DUMMY.CHATWOOT_API_KEY })).toBe(false)
    expect(isChatwootConfigured({})).toBe(false)
  })
})

describe('CreateChatwootInboxUseCase without configuration', () => {
  it('throws a typed error and makes no outbound or repository call', async () => {
    stubChatwoot({ CHATWOOT_API_URL: DUMMY.CHATWOOT_API_URL, CHATWOOT_ACCOUNT_ID: ' ' })
    await expect(createChatwootInboxUseCase.execute('pn-1')).rejects.toBeInstanceOf(ChatwootNotConfiguredError)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mock.find).not.toHaveBeenCalled()
    expect(mock.token).not.toHaveBeenCalled()
  })
})

describe('POST /api/cloud/chatwoot-inbox', () => {
  it('returns CHATWOOT_NOT_CONFIGURED with a safe message after authorization checks', async () => {
    stubChatwoot({})
    const res = await POST(post({ phoneNumberId: 'pn-1' }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('CHATWOOT_NOT_CONFIGURED')
    expect(body.error).toMatch(/bandeja nativa sigue disponible/)
    expect(body.error).not.toMatch(/CHATWOOT_|api_key|token|dummy/i)
    expect(mock.auth).toHaveBeenCalledWith(expect.anything(), 'lines', 'manage')
    expect(mock.access).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'u1' }), 'pn-1')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not reveal configuration state to users without lines:manage', async () => {
    stubChatwoot({})
    mock.auth.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    const res = await POST(post({ phoneNumberId: 'pn-1' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBeUndefined()
    expect(mock.access).not.toHaveBeenCalled()
  })

  it('does not reveal configuration state for an inaccessible number', async () => {
    stubChatwoot({})
    mock.access.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    const res = await POST(post({ phoneNumberId: 'pn-other' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBeUndefined()
  })

  it('keeps other failures generic without leaking internal messages', async () => {
    stubChatwoot(DUMMY)
    mock.find.mockResolvedValue({ phoneNumberId: 'pn-1', status: 'active', chatwootInboxId: null, displayPhone: '+54 11', wabaId: 'w' })
    mock.token.mockResolvedValue('dummy-access-token')
    fetchSpy.mockResolvedValue(new Response('internal detail dummy-key-123', { status: 500 }))
    const res = await POST(post({ phoneNumberId: 'pn-1' }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBeUndefined()
    expect(JSON.stringify(body)).not.toMatch(/dummy|500|internal/)
  })
})

describe('GET /api/lines', () => {
  it('exposes only a chatwootConfigured boolean', async () => {
    mock.query.mockResolvedValue([])
    mock.ids.mockResolvedValue(null)
    stubChatwoot({})
    expect((await (await getLines(new NextRequest('http://localhost/api/lines'))).json()).chatwootConfigured).toBe(false)
    stubChatwoot(DUMMY)
    const body = await (await getLines(new NextRequest('http://localhost/api/lines'))).json()
    expect(body.chatwootConfigured).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(/dummy-key|chatwoot\.test/)
  })
})
