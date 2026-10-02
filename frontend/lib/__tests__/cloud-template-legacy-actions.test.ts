/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { POST as submit } from '@/app/api/templates/[id]/submit/route'
import { POST as sync } from '@/app/api/templates/[id]/sync/route'

const mocks = vi.hoisted(() => ({
  query: vi.fn(), permission: vi.fn(), submit: vi.fn(), sync: vi.fn(), mapStatus: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.permission }))
vi.mock('@/lib/meta-graph', () => ({
  submitTemplateToMeta: mocks.submit, getTemplateStatusFromMeta: mocks.sync, mapMetaStatus: mocks.mapStatus,
}))

const id = '11111111-1111-4111-8111-111111111111'
const legacyTemplate = {
  name: 'legacy_template', category: 'MARKETING', language: 'es',
  components: [{ type: 'BODY', text: 'Hola' }], status: 'EN_REVISION',
  whatsapp_template_id: 'meta-template-1', waba_id: null,
}
const actions = [
  { name: 'submit', handler: submit },
  { name: 'sync', handler: sync },
]

function context(templateId = id) { return { params: Promise.resolve({ id: templateId }) } }
function request(action: string) {
  return new NextRequest(`https://example.test/api/templates/${id}/${action}`, { method: 'POST' })
}
function expectNoMetaCalls() {
  expect(mocks.submit).not.toHaveBeenCalled()
  expect(mocks.sync).not.toHaveBeenCalled()
  expect(mocks.mapStatus).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.permission.mockResolvedValue({ ok: true, user: { user_id: 'admin', role: 'admin' } })
  mocks.query.mockResolvedValueOnce([legacyTemplate]).mockResolvedValue([])
})

describe.each(actions)('legacy template $name route', ({ name, handler }) => {
  it('requires settings management permission before accessing the template', async () => {
    const forbidden = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    mocks.permission.mockResolvedValue({ ok: false, response: forbidden })
    const req = request(name)
    expect(await handler(req, context())).toBe(forbidden)
    expect(mocks.permission).toHaveBeenCalledWith(req, 'settings', 'manage')
    expect(mocks.query).not.toHaveBeenCalled()
    expectNoMetaCalls()
  })

  it('rejects malformed IDs before querying or contacting Meta', async () => {
    const response = await handler(request(name), context('not-a-uuid'))
    expect(response.status).toBe(400)
    expect(mocks.query).not.toHaveBeenCalled()
    expectNoMetaCalls()
  })

  it('returns 404 when the template does not exist', async () => {
    mocks.query.mockReset().mockResolvedValue([])
    const response = await handler(request(name), context())
    expect(response.status).toBe(404)
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expectNoMetaCalls()
  })

  it.each(['meta-template-1', null])('blocks an imported template before global Meta access (Meta ID %s)', async metaId => {
    mocks.query.mockReset().mockResolvedValue([{ ...legacyTemplate, waba_id: 'imported-waba', whatsapp_template_id: metaId }])
    const response = await handler(request(name), context())
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error).toContain('Meta')
    expect(body.error).toContain('«Sincronizar desde Meta» en Campañas')
    expectNoMetaCalls()
    expect(mocks.query).toHaveBeenCalledTimes(1)
    const [sql, params] = mocks.query.mock.calls[0]
    expect(sql).toContain('waba_id')
    expect(sql).toMatch(/^SELECT /)
    expect(params).toEqual([id])
  })
})

describe('legacy templates with no WABA', () => {
  it('still submits through the legacy helper and persists the returned Meta ID and mapped status', async () => {
    mocks.submit.mockResolvedValue({ id: 'meta-submitted', status: 'PENDING' })
    mocks.mapStatus.mockReturnValue('EN_REVISION')
    const response = await submit(request('submit'), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, whatsapp_template_id: 'meta-submitted', status: 'EN_REVISION' })
    expect(mocks.submit).toHaveBeenCalledWith({
      name: legacyTemplate.name, category: legacyTemplate.category,
      language: legacyTemplate.language, components: legacyTemplate.components,
    })
    expect(mocks.sync).not.toHaveBeenCalled()
    expect(mocks.mapStatus).toHaveBeenCalledWith('PENDING')
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE whatsapp_templates'), ['meta-submitted', 'EN_REVISION', id],
    )
  })

  it('still synchronizes the legacy Meta ID and persists the mapped status and rejection reason', async () => {
    mocks.sync.mockResolvedValue({ status: 'REJECTED', rejection_reason: 'Example rejected' })
    mocks.mapStatus.mockReturnValue('RECHAZADA')
    const response = await sync(request('sync'), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, status: 'RECHAZADA', rejection_reason: 'Example rejected' })
    expect(mocks.sync).toHaveBeenCalledWith('meta-template-1')
    expect(mocks.submit).not.toHaveBeenCalled()
    expect(mocks.mapStatus).toHaveBeenCalledWith('REJECTED')
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE whatsapp_templates'), ['RECHAZADA', 'Example rejected', id],
    )
  })

  it('retains the legacy 400 response when sync has no Meta ID', async () => {
    mocks.query.mockReset().mockResolvedValue([{ ...legacyTemplate, whatsapp_template_id: null }])
    const response = await sync(request('sync'), context())
    expect(response.status).toBe(400)
    expectNoMetaCalls()
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })
})
