/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  query: vi.fn(), transaction: vi.fn(), permission: vi.fn(), access: vi.fn(),
  token: vi.fn(), list: vi.fn(), audit: vi.fn(), dbQuery: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.permission }))
vi.mock('@/lib/line-visibility', () => ({ getAccessibleLineIds: mocks.access }))
vi.mock('@/lib/cloud-api/token-store', () => ({ getTokenForNumber: mocks.token }))
vi.mock('@/lib/cloud-api/client', () => ({ MetaCloudApiClient: class { listTemplates = mocks.list } }))
vi.mock('@/lib/audit', () => ({ audit: mocks.audit }))

import { POST } from '@/app/api/templates/sync-cloud/route'

const user = { user_id: 'user-1', role: 'operator', is_super_admin: false }
const accountA = { waba_id: '1111', phone_number_id: '1001' }
const accountB = { waba_id: '2222', phone_number_id: '2001' }
const template = (id = '9001', status = 'APPROVED', name = 'same_name') => ({
  id, name, status, language: 'es_AR', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hola' }],
})
const request = () => new NextRequest('https://example.test/api/templates/sync-cloud', {
  method: 'POST', body: JSON.stringify({ waba_id: 'unassigned-waba' }),
})
type Row = { waba: string; metaId: string; name: string; language: string; status: string }
let rows: Row[]
let failTransactionFor: string | undefined

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
  mocks.permission.mockResolvedValue({ ok: true, user })
  mocks.access.mockResolvedValue(['line-1'])
  mocks.query.mockResolvedValue([accountA])
  mocks.token.mockResolvedValue('synthetic-access-token')
  mocks.list.mockResolvedValue([template()])
  rows = []
  failTransactionFor = undefined
  // Model only atomic commit/rollback; SQL shape and bind scoping are asserted separately.
  mocks.transaction.mockImplementation(async (work: (db: { query: typeof mocks.dbQuery }) => Promise<void>) => {
    const staged = rows.map(row => ({ ...row }))
    mocks.dbQuery.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.includes('INSERT INTO whatsapp_templates')) {
        const row = { name: values[0], language: values[2], status: values[3], metaId: values[5], waba: values[6] } as Row
        const existing = staged.find(r => r.waba === row.waba && r.name === row.name && r.language === row.language)
        if (existing) Object.assign(existing, row)
        else staged.push(row)
      } else if (sql.includes("SET status='DESHABILITADA'")) {
        if (values[0] === failTransactionFor) throw new Error('synthetic transaction failure')
        const ids = values[1] as string[]
        for (const row of staged) if (row.waba === values[0] && !ids.includes(row.metaId)) row.status = 'DESHABILITADA'
      }
      return { rows: [] }
    })
    await work({ query: mocks.dbQuery })
    rows = staged
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('Cloud catalogue sync authorization and WABA isolation', () => {
  it('requires campaigns:create before reading accounts, tokens or Meta', async () => {
    mocks.permission.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await POST(request())).status).toBe(403)
    expect(mocks.permission).toHaveBeenCalledWith(expect.any(NextRequest), 'campaigns', 'create')
    expect(mocks.access).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.token).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('fails closed for a user with no accessible active lines', async () => {
    mocks.access.mockResolvedValue([])
    mocks.query.mockResolvedValue([])
    expect((await POST(request())).status).toBe(409)
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('whatsapp_line_id=ANY($1::uuid[])'), [[]])
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('uses authorized active accounts instead of a caller supplied WABA', async () => {
    expect((await POST(request())).status).toBe(200)
    expect(mocks.access).toHaveBeenCalledWith(user)
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("WHERE status='active'"), [['line-1']])
    expect(mocks.token).toHaveBeenCalledExactlyOnceWith(accountA.phone_number_id)
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith(accountA.waba_id)
    expect(mocks.dbQuery).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['templates:1111'])
    expect(rows).toEqual([{ waba: '1111', metaId: '9001', name: 'same_name', language: 'es_AR', status: 'APROBADA' }])
  })

  it('supports the explicit all-lines scope returned for a super administrator', async () => {
    mocks.access.mockResolvedValue(null)
    expect((await POST(request())).status).toBe(200)
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('$1::uuid[] IS NULL'), [null])
  })

  it('keeps identical template names independent across WABAs', async () => {
    mocks.query.mockResolvedValue([accountA, accountB])
    mocks.list.mockResolvedValueOnce([template('9001')]).mockResolvedValueOnce([template('9002', 'REJECTED')])
    const response = await POST(request())
    expect(await response.json()).toEqual({ ok: true, synced: 2, accounts: 2 })
    expect(rows.map(row => [row.waba, row.name, row.metaId, row.status])).toEqual([
      ['1111', 'same_name', '9001', 'APROBADA'], ['2222', 'same_name', '9002', 'RECHAZADA'],
    ])
    const inserts = mocks.dbQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO whatsapp_templates'))
    expect(inserts).toHaveLength(2)
    for (const [sql] of inserts) expect(sql).toContain('ON CONFLICT (waba_id,name,language) WHERE waba_id IS NOT NULL')
  })
})

describe('Cloud catalogue sync failure boundaries', () => {
  it('preserves the failed WABA while committing a successful account snapshot', async () => {
    rows = [
      { waba: '1111', metaId: '8001', name: 'old_a', language: 'es_AR', status: 'APROBADA' },
      { waba: '2222', metaId: '8002', name: 'old_b', language: 'es_AR', status: 'APROBADA' },
    ]
    mocks.query.mockResolvedValue([accountA, accountB])
    mocks.list.mockResolvedValueOnce([template()]).mockRejectedValueOnce(new Error('synthetic private provider detail'))
    const response = await POST(request())
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ synced: 1, failed_accounts: 1 })
    expect(rows.find(row => row.metaId === '8001')?.status).toBe('DESHABILITADA')
    expect(rows.find(row => row.metaId === '8002')?.status).toBe('APROBADA')
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.dbQuery.mock.calls.filter(([sql]) => sql.includes("SET status='DESHABILITADA'")))
      .toEqual([[expect.stringContaining('WHERE waba_id=$1'), ['1111', ['9001']]]])
  })

  it('does not partially replace a catalogue when its transaction fails', async () => {
    rows = [{ waba: '1111', metaId: '8001', name: 'same_name', language: 'es_AR', status: 'APROBADA' }]
    failTransactionFor = '1111'
    mocks.list.mockResolvedValue([template('9001', 'REJECTED')])
    const response = await POST(request())
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ synced: 0, failed_accounts: 1 })
    expect(rows).toEqual([{ waba: '1111', metaId: '8001', name: 'same_name', language: 'es_AR', status: 'APROBADA' }])
  })

  it('never disables existing data after a malformed catalogue', async () => {
    mocks.list.mockResolvedValue([{ ...template(), id: 'not-a-meta-id' }])
    expect((await POST(request())).status).toBe(502)
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.dbQuery).not.toHaveBeenCalled()
  })

  it('disables missing templates only after a complete empty snapshot of that WABA', async () => {
    rows = [
      { waba: '1111', metaId: '8001', name: 'old_a', language: 'es_AR', status: 'APROBADA' },
      { waba: '2222', metaId: '8002', name: 'old_b', language: 'es_AR', status: 'APROBADA' },
    ]
    mocks.list.mockResolvedValue([])
    expect((await POST(request())).status).toBe(200)
    expect(rows.map(row => row.status)).toEqual(['DESHABILITADA', 'APROBADA'])
  })

  it.each([['PENDING', 'EN_REVISION'], ['PAUSED', 'DESHABILITADA'], ['DISABLED', 'DESHABILITADA']])(
    'maps Meta %s to internal %s so blocked templates cannot dispatch', async (metaStatus, internalStatus) => {
      mocks.list.mockResolvedValue([template('9001', metaStatus)])
      expect((await POST(request())).status).toBe(200)
      expect(rows[0].status).toBe(internalStatus)
    },
  )

  it('does not expose provider details or tokens in failure responses or audit metadata', async () => {
    mocks.list.mockRejectedValue(new Error('synthetic-access-token private Graph response'))
    const response = await POST(request())
    const body = await response.text()
    expect(body).not.toContain('synthetic-access-token')
    expect(body).not.toContain('private Graph response')
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: {
      action: 'sync_cloud_catalogue', synced: 0, failed_accounts: 1,
    } }))
  })
})
