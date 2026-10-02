/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  query: vi.fn(), transaction: vi.fn(), dbQuery: vi.fn(), permission: vi.fn(), audit: vi.fn(), list: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.permission }))
vi.mock('@/lib/line-visibility', () => ({ getAccessibleLineIds: async () => null }))
vi.mock('@/lib/audit', () => ({ audit: mocks.audit }))
vi.mock('@/lib/security-log', () => ({ securityLog: vi.fn() }))
vi.mock('@/lib/cloud-api/token-store', () => ({ getTokenForNumber: async () => 'synthetic-token' }))
vi.mock('@/lib/cloud-api/client', () => ({ MetaCloudApiClient: class { listTemplates = mocks.list } }))

import { POST as create } from '@/app/api/templates/route'
import { PATCH as patch } from '@/app/api/templates/[id]/route'
import { POST as syncCloud } from '@/app/api/templates/sync-cloud/route'

const id = '11111111-1111-4111-8111-111111111111'
const user = { user_id: 'admin-1', role: 'admin', is_super_admin: true }
const req = (method: string, body: unknown) => new NextRequest('https://example.test/api/templates', {
  method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
})
const body = { type: 'BODY', text: 'Hola {{1}}, tu consulta fue registrada.', example: { body_text: [['Ana']] } }
const draft = { name: '  Aviso  Soporte ', category: 'UTILITY', language: 'es_AR', components: [body] }
let legacy: boolean

const isColumnLookup = (sql: string) => sql.includes('pg_catalog.pg_attribute')
const calls = (pattern: string) => mocks.query.mock.calls.filter(([sql]) => String(sql).includes(pattern))

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
  legacy = true
  mocks.permission.mockResolvedValue({ ok: true, user })
  mocks.query.mockImplementation(async (sql: string) => {
    if (isColumnLookup(sql)) return [{ domain: legacy, body: legacy }]
    if (sql.startsWith('SELECT waba_id')) return [{ waba_id: null }]
    return [{ id }]
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('POST /api/templates', () => {
  it('fills domain and body on the historical table', async () => {
    const res = await create(req('POST', draft))
    expect(res.status).toBe(201)
    const [[sql, values]] = calls('INSERT INTO whatsapp_templates')
    expect(sql).toContain('(name, category, language, components, created_by, domain, body)')
    expect(values).toEqual(['aviso_soporte', 'UTILITY', 'es_AR', JSON.stringify([body]), 'admin-1', 'general', body.text])
  })

  it('omits the legacy columns on a modern table', async () => {
    legacy = false
    expect((await create(req('POST', draft))).status).toBe(201)
    const [[sql, values]] = calls('INSERT INTO whatsapp_templates')
    expect(sql).not.toMatch(/domain|body/)
    expect(values).toHaveLength(5)
  })

  it.each([
    ['nombre', { ...draft, name: 'aviso.soporte' }, 'name'],
    ['nombre largo', { ...draft, name: 'a'.repeat(101) }, 'name'],
    ['BODY vacío', { ...draft, components: [{ type: 'BODY', text: '   ' }] }, 'components.0.text'],
    ['variable con hueco', { ...draft, components: [{ type: 'BODY', text: 'Hola {{1}} {{3}}', example: { body_text: [['a', 'b']] } }] }, 'components.0.text'],
    ['ejemplo en blanco', { ...draft, components: [{ ...body, example: { body_text: [[' ']] } }] }, 'components.0.example.body_text.0.0'],
    ['botón vacío', { ...draft, components: [body, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: '' }] }] }, 'components.1.buttons.0.text'],
    ['lista de botones vacía', { ...draft, components: [body, { type: 'BUTTONS', buttons: [] }] }, 'components.1.buttons'],
  ])('rejects %s with a field issue and never touches the database', async (_label, payload, path) => {
    const res = await create(req('POST', payload))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path })]))
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'create' }))
  })
})

describe('PATCH /api/templates/[id]', () => {
  const ctx = { params: Promise.resolve({ id }) }

  it('mirrors BODY into the legacy body column without touching domain', async () => {
    expect((await patch(req('PATCH', { components: [body] }), ctx)).status).toBe(200)
    const [[sql, values]] = calls('UPDATE whatsapp_templates')
    expect(sql).toContain('components = $1::jsonb, body = $2 WHERE id = $3 AND waba_id IS NULL')
    expect(sql).not.toContain('domain')
    expect(values).toEqual([JSON.stringify([body]), body.text, id])
  })

  it('does not read column metadata or write body when components are not supplied', async () => {
    expect((await patch(req('PATCH', { status: 'BORRADOR' }), ctx)).status).toBe(200)
    expect(mocks.query.mock.calls.some(([sql]) => isColumnLookup(sql))).toBe(false)
    expect(calls('UPDATE whatsapp_templates')[0][0]).not.toContain('body')
  })

  it('keeps the imported-template guard ahead of any metadata read', async () => {
    mocks.query.mockResolvedValue([{ waba_id: '1111' }])
    expect((await patch(req('PATCH', { components: [body] }), ctx)).status).toBe(409)
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/templates/sync-cloud on the historical table', () => {
  it('fills body/domain on insert, updates only body on conflict, inside the WABA lock', async () => {
    mocks.query.mockResolvedValue([{ waba_id: '1111', phone_number_id: '1001' }])
    mocks.list.mockResolvedValue([{ id: '9001', name: 'aviso', status: 'APPROVED', language: 'es_AR', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Consulta registrada' }] }])
    mocks.dbQuery.mockImplementation(async (sql: string) => ({ rows: isColumnLookup(sql) ? [{ domain: true, body: true }] : [] }))
    mocks.transaction.mockImplementation(async (work: (db: unknown) => Promise<void>) => work({ query: mocks.dbQuery }))

    expect((await syncCloud(req('POST', {}))).status).toBe(200)
    const sqls = mocks.dbQuery.mock.calls.map(([sql]) => String(sql))
    expect(sqls[0]).toBe('SELECT pg_advisory_xact_lock(hashtext($1))')
    expect(isColumnLookup(sqls[1])).toBe(true)
    const [upsertSql, values] = mocks.dbQuery.mock.calls[2]
    expect(upsertSql).toContain('body=EXCLUDED.body')
    expect(upsertSql).not.toContain('domain=EXCLUDED')
    expect(values.slice(-2)).toEqual(['general', 'Consulta registrada'])
    expect(sqls.at(-1)).toContain("SET status='DESHABILITADA'")
  })
})
