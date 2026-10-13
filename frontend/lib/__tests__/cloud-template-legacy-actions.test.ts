/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { POST as submit } from '@/app/api/templates/[id]/submit/route'
import { POST as sync } from '@/app/api/templates/[id]/sync/route'
const m = vi.hoisted(() => ({ query: vi.fn(), db: vi.fn(), transaction: vi.fn(), permission: vi.fn(), account: vi.fn(), token: vi.fn(), list: vi.fn(), create: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: m.query, withTransaction: m.transaction }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: m.permission }))
vi.mock('@/lib/template-accounts', () => ({ templateAccountNumber: m.account }))
vi.mock('@/lib/cloud-api/token-store', () => ({ getTokenForNumber: m.token }))
vi.mock('@/lib/cloud-api/client', () => ({ MetaCloudApiClient: class { createTemplate = m.create; listTemplates = m.list } }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
const id = '11111111-1111-4111-8111-111111111111'
const tpl = { name: 'promo_20', category: 'MARKETING', language: 'es', components: [{ type: 'BODY', text: '20% de descuento' }], status: 'BORRADOR', waba_id: '22222', whatsapp_template_id: null }
const ctx = () => ({ params: Promise.resolve({ id }) })
const req = () => new NextRequest(`https://example.test/api/templates/${id}/submit`, { method: 'POST' })
beforeEach(() => {
  vi.resetAllMocks()
  m.permission.mockResolvedValue({ ok: true, user: { user_id: 'admin', role: 'admin' } })
  m.query.mockResolvedValue([tpl]); m.db.mockResolvedValue({ rows: [tpl] })
  m.transaction.mockImplementation(work => work({ query: m.db }))
  m.account.mockResolvedValue('20001'); m.token.mockResolvedValue('synthetic-token')
  m.list.mockResolvedValue([]); m.create.mockResolvedValue({ id: '90001', status: 'PENDING' })
})
describe.each([{ name: 'submit', handler: submit }, { name: 'sync', handler: sync }])('$name account isolation', ({ handler }) => {
  it('requires management permission before accessing credentials', async () => {
    m.permission.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) })
    expect((await handler(req(), ctx())).status).toBe(403)
    expect(m.query).not.toHaveBeenCalled(); expect(m.transaction).not.toHaveBeenCalled(); expect(m.token).not.toHaveBeenCalled()
  })
  it('rejects invalid IDs', async () => {
    expect((await handler(req(), { params: Promise.resolve({ id: 'invalid' }) })).status).toBe(400)
    expect(m.token).not.toHaveBeenCalled()
  })
  it('returns 404 for missing templates', async () => {
    m.query.mockResolvedValue([]); m.db.mockResolvedValue({ rows: [] })
    expect((await handler(req(), ctx())).status).toBe(404)
    expect(m.token).not.toHaveBeenCalled()
  })
  it('never falls back to global credentials for unassigned templates', async () => {
    m.query.mockResolvedValue([{ ...tpl, waba_id: null }]); m.db.mockResolvedValue({ rows: [{ ...tpl, waba_id: null }] })
    expect((await handler(req(), ctx())).status).toBe(409)
    expect(m.token).not.toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled()
  })
  it('rejects inaccessible accounts before reading credentials', async () => {
    m.account.mockResolvedValue(null)
    expect((await handler(req(), ctx())).status).toBe(403)
    expect(m.token).not.toHaveBeenCalled()
  })
})
describe('account-specific submission and status', () => {
  it('submits to the draft account and records its own approval', async () => {
    expect((await submit(req(), ctx())).status).toBe(200)
    expect(m.token).toHaveBeenCalledWith('20001')
    expect(m.create).toHaveBeenCalledWith({ wabaId: '22222', name: tpl.name, category: tpl.category, language: tpl.language, components: tpl.components })
    expect(m.db).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE whatsapp_templates'), ['90001', 'EN_REVISION', id])
    expect(m.db.mock.calls[0][0]).toContain('FOR UPDATE')
  })
  it('does not resubmit linked templates', async () => {
    m.db.mockResolvedValue({ rows: [{ ...tpl, whatsapp_template_id: '90001' }] })
    expect((await submit(req(), ctx())).status).toBe(409); expect(m.create).not.toHaveBeenCalled()
  })
  it('requires reconciliation when name/language already exists in Meta', async () => {
    m.list.mockResolvedValue([{ ...tpl, id: '90002', status: 'APPROVED' }])
    expect((await submit(req(), ctx())).status).toBe(409); expect(m.create).not.toHaveBeenCalled()
    expect(m.db).toHaveBeenCalledTimes(1)
  })
  it('synchronizes the ID only within its owning account', async () => {
    m.query.mockResolvedValue([{ ...tpl, whatsapp_template_id: '90001' }]); m.list.mockResolvedValue([{ id: '90001', status: 'PAUSED' }])
    expect((await sync(req(), ctx())).status).toBe(200)
    expect(m.list).toHaveBeenCalledWith('22222')
    expect(m.query).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE whatsapp_templates'), ['DESHABILITADA', null, id])
  })
  it('preserves the previous state on provider failure without leaking credentials', async () => {
    m.query.mockResolvedValue([{ ...tpl, whatsapp_template_id: '90001' }]); m.list.mockRejectedValue(new Error('synthetic-token'))
    const res = await sync(req(), ctx())
    expect(res.status).toBe(502); expect(await res.text()).not.toContain('synthetic-token'); expect(m.query).toHaveBeenCalledTimes(1)
  })
})
