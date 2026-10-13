/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { POST } from '@/app/api/templates/[id]/copy/route'
import { GET } from '@/app/api/templates/route'
const m = vi.hoisted(() => ({ query: vi.fn(), permission: vi.fn(), access: vi.fn(), account: vi.fn(), listAccounts: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: m.query }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: m.permission }))
vi.mock('@/lib/line-visibility', () => ({ getAccessibleLineIds: m.access }))
vi.mock('@/lib/template-accounts', () => ({ templateAccountNumber: m.account, listTemplateAccounts: m.listAccounts }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
const id = '11111111-1111-4111-8111-111111111111'
const source = { waba_id: '11111', category: 'MARKETING', language: 'es_AR', components: [
  { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://example.test/promo.png'] } },
  { type: 'BODY', text: '20% en {{1}}', example: { body_text: [['Accesorios']] } },
  { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver productos', url: 'https://example.test' }] },
] }
const req = (body: unknown = { waba_id: '22222', name: 'promo_20' }) => new NextRequest(`https://example.test/api/templates/${id}/copy`, { method: 'POST', body: JSON.stringify(body) })
const ctx = { params: Promise.resolve({ id }) }
beforeEach(() => {
  vi.resetAllMocks()
  m.permission.mockResolvedValue({ ok: true, user: { user_id: 'admin', role: 'admin' } }); m.access.mockResolvedValue(['line-id']); m.account.mockResolvedValue('20001')
  m.listAccounts.mockResolvedValue([{ waba_id: '11111', name: 'Nexus' }, { waba_id: '22222', name: 'Lexora' }])
  m.query.mockImplementation(async (sql: string) => sql.includes('pg_catalog') ? [{ domain: false, body: false }] : sql.startsWith('INSERT') ? [{ id: 'new-id' }] : [source])
})
describe('copy and account filtering', () => {
  it('copies all content without transferring approval, Meta ID or usage and never writes the source', async () => {
    const res = await POST(req(), ctx)
    expect(res.status).toBe(201); expect(await res.json()).toEqual({ id: 'new-id', status: 'BORRADOR' })
    const [sql, values] = m.query.mock.calls.find(([sql]) => sql.startsWith('INSERT'))!
    expect(values).toEqual(['promo_20', 'MARKETING', 'es_AR', JSON.stringify(source.components), 'admin', '22222'])
    expect(sql).not.toMatch(/whatsapp_template_id|usage_count|status|UPDATE/)
    expect(m.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false)
    expect(m.query.mock.calls[0][1]).toEqual([id, ['line-id']])
  })
  it('requires authorization before database access', async () => {
    m.permission.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(req(), ctx)).status).toBe(403); expect(m.query).not.toHaveBeenCalled()
  })
  it('does not copy an inaccessible source', async () => {
    m.query.mockResolvedValue([]); expect((await POST(req(), ctx)).status).toBe(404); expect(m.account).not.toHaveBeenCalled()
  })
  it('requires access to a different destination account', async () => {
    expect((await POST(req({ waba_id: '11111', name: 'promo_20' }), ctx)).status).toBe(400)
    m.account.mockResolvedValue(null); expect((await POST(req(), ctx)).status).toBe(403)
    expect(m.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false)
  })
  it('reports name/language collisions without overwriting the destination', async () => {
    m.query.mockImplementation(async (sql: string) => { if (sql.startsWith('INSERT')) throw Object.assign(new Error(), { code: '23505' }); return sql.includes('pg_catalog') ? [{ domain: false, body: false }] : [source] })
    expect((await POST(req(), ctx)).status).toBe(409)
  })
  it('combines the account filter with user visibility', async () => {
    const res = await GET(new NextRequest('https://example.test/api/templates?waba_id=22222&status=APROBADA'))
    expect(res.status).toBe(200); expect(m.query.mock.calls[0][1]).toEqual(['APROBADA', '', '', ['line-id'], '22222'])
    expect(m.query.mock.calls[0][0]).toContain('waba_id=$5'); expect(m.query.mock.calls[0][0]).toContain('cn.whatsapp_line_id=ANY($4::uuid[])')
    expect((await res.json()).accounts).toHaveLength(2)
  })
  it('keeps historical unassigned templates distinguishable', async () => {
    expect((await GET(new NextRequest('https://example.test/api/templates?waba_id=unassigned'))).status).toBe(200)
    expect(m.query.mock.calls[0][1][4]).toBe('unassigned')
  })
})
