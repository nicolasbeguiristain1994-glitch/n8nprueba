/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({ query: vi.fn(), permission: vi.fn(), access: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.permission }))
vi.mock('@/lib/line-visibility', () => ({ getAccessibleLineIds: mocks.access }))
vi.mock('@/lib/audit', () => ({ audit: mocks.audit }))
vi.mock('@/lib/security-log', () => ({ securityLog: vi.fn() }))

import { GET, PATCH } from '@/app/api/templates/[id]/route'

const id = '11111111-1111-4111-8111-111111111111'
const lineId = '22222222-2222-4222-8222-222222222222'
const user = { user_id: 'operator-1', role: 'operator', is_super_admin: false }
const context = () => ({ params: Promise.resolve({ id }) })
const request = (method = 'GET', body?: unknown) => new NextRequest(`https://example.test/api/templates/${id}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
})
const imported = { id, name: 'cloud_greeting', status: 'APROBADA', language: 'es', waba_id: '12345', components: [{ type: 'BODY', text: 'Hola' }] }

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
  mocks.permission.mockResolvedValue({ ok: true, user })
  mocks.access.mockResolvedValue([lineId])
  mocks.query.mockResolvedValue([imported])
})
afterEach(() => vi.unstubAllGlobals())

describe('Cloud template detail visibility', () => {
  it('checks campaigns:read before querying line visibility or a template', async () => {
    mocks.permission.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await GET(request(), context())).status).toBe(403)
    expect(mocks.permission).toHaveBeenCalledWith(expect.any(NextRequest), 'campaigns', 'read')
    expect(mocks.access).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('returns an accessible template using the same active-WABA scope as the catalogue', async () => {
    const response = await GET(request(), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ template: imported })
    expect(mocks.access).toHaveBeenCalledWith(user)
    const [sql, values] = mocks.query.mock.calls[0]
    expect(values).toEqual([id, [lineId]])
    expect(sql).toContain('cn.waba_id=whatsapp_templates.waba_id')
    expect(sql).toContain('cn.whatsapp_line_id=ANY($2::uuid[])')
    expect(sql).toContain("cn.status='active'")
  })

  it('returns the same 404 for an inaccessible or nonexistent imported template', async () => {
    mocks.access.mockResolvedValue([])
    mocks.query.mockResolvedValue([])
    const response = await GET(request(), context())
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Plantilla no encontrada' })
    expect(mocks.query.mock.calls[0][1]).toEqual([id, []])
  })

  it('preserves catalogue visibility for legacy templates without a WABA', async () => {
    mocks.access.mockResolvedValue([])
    mocks.query.mockResolvedValue([{ ...imported, waba_id: null }])
    expect((await GET(request(), context())).status).toBe(200)
    expect(mocks.query.mock.calls[0][0]).toContain('waba_id IS NULL OR $2::uuid[] IS NULL')
  })

  it('allows the explicit all-lines scope for a super administrator', async () => {
    mocks.access.mockResolvedValue(null)
    expect((await GET(request(), context())).status).toBe(200)
    expect(mocks.query.mock.calls[0][1]).toEqual([id, null])
  })

  it('rejects invalid template IDs before querying visibility', async () => {
    expect((await GET(request(), { params: Promise.resolve({ id: 'invalid' }) })).status).toBe(400)
    expect(mocks.access).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
  })
})

describe('Imported templates stay authoritative to Meta', () => {
  it.each([
    { name: 'locally_changed' }, { language: 'en' },
    { components: [{ type: 'BODY', text: 'Different from Meta' }] }, { status: 'APROBADA' },
    { category: 'UTILITY' }, { rejection_reason: null },
  ])('rejects local imported-template changes %j without writing', async body => {
    const response = await PATCH(request('PATCH', body), context())
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('Editá en Meta y sincronizá')
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith('SELECT waba_id FROM whatsapp_templates WHERE id=$1', [id])
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('preserves the normal admin editing flow for a legacy template', async () => {
    mocks.query.mockResolvedValueOnce([{ waba_id: null }]).mockResolvedValueOnce([{ id }])
    const response = await PATCH(request('PATCH', { name: 'Legacy Name', language: 'es', status: 'BORRADOR' }), context())
    expect(response.status).toBe(200)
    expect(mocks.permission).toHaveBeenCalledWith(expect.any(NextRequest), 'settings', 'manage')
    const [sql, values] = mocks.query.mock.calls[1]
    expect(sql).toContain('AND waba_id IS NULL RETURNING id')
    expect(values).toEqual(['legacy_name', 'es', 'BORRADOR', id])
    expect(mocks.audit).toHaveBeenCalledTimes(1)
  })

  it('does not write when the template does not exist', async () => {
    mocks.query.mockResolvedValue([])
    expect((await PATCH(request('PATCH', { status: 'APROBADA' }), context())).status).toBe(404)
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('requires settings:manage before reading or changing template ownership', async () => {
    mocks.permission.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await PATCH(request('PATCH', { status: 'APROBADA' }), context())).status).toBe(403)
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})
