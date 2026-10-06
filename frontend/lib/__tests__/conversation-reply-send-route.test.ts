// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn(), visible: vi.fn(), eligible: vi.fn(), replyEligible: vi.fn(), cloud: vi.fn(), evolution: vi.fn(), select: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth, isOwnerOrAdmin: () => true }))
vi.mock('@/lib/line-visibility', () => ({ getAccessibleLineIds: mocks.visible }))
vi.mock('@/lib/campaign-distributor', () => ({ getEligibleLines: mocks.eligible, getEligibleReplyLines: mocks.replyEligible, sendViaCloud: mocks.cloud, sendViaEvolution: mocks.evolution, selectLine: mocks.select }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/sse-events', () => ({ sseEmitter: { emit: vi.fn() } }))
import { POST } from '@/app/api/send/route'

const lineA = { id: 'a', line_type: 'cloud', phone_number_id: '10001' }
const lineB = { id: 'b', line_type: 'cloud', phone_number_id: '10002' }
const request = (overrides = {}) => new NextRequest('https://panel.test/api/send', { method: 'POST', body: JSON.stringify({ phones: ['5491100000001'], message: 'Respuesta de prueba', ...overrides }) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ ok: true, user: { user_id: 'operator', role: 'admin' } })
  mocks.visible.mockResolvedValue(['a', 'b'])
  mocks.eligible.mockResolvedValue([lineB, lineA])
  mocks.replyEligible.mockResolvedValue([lineB, lineA])
  mocks.select.mockReturnValue(lineB)
  mocks.cloud.mockResolvedValue({ messageId: 'wamid.test' })
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM cloud_messages cm')) return [{ line_id: 'a', phone_number_id: '10001', display_name: 'Difusion 1' }]
    if (sql.includes('SELECT line_id FROM phone_line_assignments')) return [{ line_id: 'b' }]
    return []
  })
})

describe('manual replies preserve the incoming business number', () => {
  it('uses the inbound line instead of an unrelated assignment or the highest capacity sender', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect((await response.json()).results[0].status).toBe('sent')
    expect(mocks.cloud).toHaveBeenCalledWith(lineA, '+5491100000001', { kind: 'text', body: 'Respuesta de prueba', mediaUrl: null }, undefined, { purpose: 'conversation_reply', reserveCapacity: true })
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('phone_line_assignments'))).toBe(false)
    expect(mocks.select).not.toHaveBeenCalled()
  })

  it('replies from the receiving number even when no lines allow campaigns', async () => {
    mocks.eligible.mockResolvedValue([])
    expect((await (await POST(request())).json()).results[0].status).toBe('sent')
    expect(mocks.cloud.mock.calls[0][0]).toEqual(lineA)
    expect(mocks.replyEligible).toHaveBeenCalledWith('operator')
  })

  it('does not rotate to another sender when the inbound line is disconnected or capped', async () => {
    mocks.eligible.mockResolvedValue([lineB])
    mocks.replyEligible.mockResolvedValue([lineB])
    const body = await (await POST(request())).json()
    expect(body.results[0]).toMatchObject({ status: 'error', error: expect.stringContaining('Difusion 1') })
    expect(mocks.cloud).not.toHaveBeenCalled()
    expect(mocks.evolution).not.toHaveBeenCalled()
    expect(mocks.select).not.toHaveBeenCalled()
  })

  it('keeps the service-window guard and does not retry from another line when it is closed', async () => {
    mocks.cloud.mockRejectedValueOnce(new Error('No hay ventana de servicio abierta.'))
    const body = await (await POST(request())).json()
    expect(body.results[0].error).toContain('ventana de servicio')
    expect(mocks.cloud).toHaveBeenCalledTimes(1)
    expect(mocks.cloud.mock.calls[0][0]).toEqual(lineA)
  })

  it('preserves assigned-sender behavior for destinations without an inbound Cloud message', async () => {
    mocks.query.mockImplementation(async (sql: string) => sql.includes('SELECT line_id FROM phone_line_assignments') ? [{ line_id: 'b' }] : [])
    expect((await (await POST(request())).json()).results[0].status).toBe('sent')
    expect(mocks.cloud.mock.calls[0][0]).toEqual(lineB)
    expect(mocks.cloud.mock.calls[0]).toHaveLength(4)
  })

  it('cannot initiate outreach using a line that only allows replies', async () => {
    mocks.eligible.mockResolvedValue([])
    mocks.query.mockResolvedValue([])
    const body = await (await POST(request())).json()
    expect(body.results[0].error).toContain('iniciar esta conversación')
    expect(mocks.cloud).not.toHaveBeenCalled()
    expect(mocks.select).not.toHaveBeenCalled()
  })

  it.each([
    { phones: ['5491100000001', '5491100000002'] },
    { campaign_id: '00000000-0000-4000-8000-000000000001' },
  ])('does not use reply eligibility for bulk or campaign sends: %j', async overrides => {
    mocks.eligible.mockResolvedValue([])
    mocks.query.mockResolvedValue([{ owned_by: 'operator' }])
    expect((await POST(request(overrides))).status).toBe(503)
    expect(mocks.replyEligible).not.toHaveBeenCalled()
    expect(mocks.cloud).not.toHaveBeenCalled()
  })

  it('refuses recipients outside the operator scope before reading reply candidates', async () => {
    mocks.auth.mockResolvedValue({ ok: true, user: { user_id: 'operator', role: 'operator', sectors: ['conversations'] } })
    mocks.query.mockResolvedValue([{ denied: true }])
    expect((await POST(request())).status).toBe(403)
    expect(mocks.replyEligible).not.toHaveBeenCalled()
    expect(mocks.cloud).not.toHaveBeenCalled()
  })

  it('refuses unauthenticated sends before reading sender history', async () => {
    mocks.auth.mockResolvedValue({ ok: false, response: Response.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await POST(request())).status).toBe(401)
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.cloud).not.toHaveBeenCalled()
  })
})
