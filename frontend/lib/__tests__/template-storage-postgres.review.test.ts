/** @vitest-environment node */
// Explicit opt-in; only synthetic TEMP tables on a verified loopback PostgreSQL.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  query: vi.fn(), transaction: vi.fn(), permission: vi.fn(), access: vi.fn(),
  token: vi.fn(), list: vi.fn(), audit: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.permission }))
vi.mock('@/lib/line-visibility', () => ({ getAccessibleLineIds: mocks.access }))
vi.mock('@/lib/cloud-api/token-store', () => ({ getTokenForNumber: mocks.token }))
vi.mock('@/lib/cloud-api/client', () => ({ MetaCloudApiClient: class { listTemplates = mocks.list } }))
vi.mock('@/lib/audit', () => ({ audit: mocks.audit }))
vi.mock('@/lib/security-log', () => ({ securityLog: vi.fn() }))

import { POST as create } from '@/app/api/templates/route'
import { PATCH as patch } from '@/app/api/templates/[id]/route'
import { POST as sync } from '@/app/api/templates/sync-cloud/route'

const userId = '11111111-1111-4111-8111-111111111111'
const lineA = '22222222-2222-4222-8222-222222222222'
const lineB = '33333333-3333-4333-8333-333333333333'
const user = { user_id: userId, role: 'admin', is_super_admin: false }
const shapes = [
  { label: 'legacy required columns without defaults', domain: true, body: true },
  { label: 'modern without legacy columns', domain: false, body: false },
  { label: 'mixed with domain only', domain: true, body: false },
  { label: 'mixed with body only', domain: false, body: true },
] as const
type Shape = typeof shapes[number]
type StoredRow = {
  id: string; name: string; language: string; status: string; components: unknown[]
  whatsapp_template_id: string | null; waba_id: string | null; usage_count: number
  domain?: string; body?: string
}

function request(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/templates${path}`, {
    method, ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  })
}
const context = (id: string) => ({ params: Promise.resolve({ id }) })
const bodyComponent = (text: string) => [{ type: 'BODY', text }]
const draft = (name: string, components: unknown[] = bodyComponent('La solicitud está registrada.')) => ({
  name, category: 'UTILITY', language: 'es_AR', components,
})
const imported = (id: string, text: string, language = 'es_AR') => ({
  id, name: 'catalogue_notice', category: 'UTILITY', language,
  status: 'APPROVED', components: bodyComponent(text),
})

describe.skipIf(process.env.RUN_TEMPLATE_PG_TESTS !== '1')('Template routes on real local PostgreSQL', () => {
  let db: Client
  let connected = false
  let inTransaction = false
  let savepointSequence = 0

  beforeAll(async () => {
    // Never read .env, credentials, or a remote service in this test.
    const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search || url.hash) {
      throw new Error('An explicit loopback DATABASE_URL without URL options is required')
    }
    db = new Client({ connectionString: url.toString(), ssl: false, connectionTimeoutMillis: 5000 })
    await db.connect()
    connected = true
  })

  beforeEach(async () => {
    vi.resetAllMocks()
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
    mocks.permission.mockResolvedValue({ ok: true, user })
    mocks.access.mockResolvedValue([lineA])
    mocks.token.mockResolvedValue('synthetic-token-never-sent')
    mocks.list.mockResolvedValue([])
    await db.query('BEGIN')
    inTransaction = true
    await db.query("SET LOCAL search_path = pg_temp; SET LOCAL statement_timeout = '5s'")
    // Execute both the actual pg_catalog inspection and route writes on the same session.
    mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => (await db.query(sql, values)).rows)
    mocks.transaction.mockImplementation(async (work: (client: { query: Client['query'] }) => Promise<unknown>) => {
      const savepoint = `template_route_${++savepointSequence}`
      await db.query(`SAVEPOINT ${savepoint}`)
      try {
        const result = await work({ query: db.query.bind(db) })
        await db.query(`RELEASE SAVEPOINT ${savepoint}`)
        return result
      } catch (error) {
        await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        await db.query(`RELEASE SAVEPOINT ${savepoint}`)
        throw error
      }
    })
  })

  afterEach(async () => {
    try {
      if (inTransaction) await db.query('ROLLBACK')
    } finally {
      inTransaction = false
      vi.unstubAllGlobals()
    }
  })
  afterAll(async () => { if (connected) await db.end() })

  async function fixture(shape: Shape) {
    // All interpolated DDL fragments below are fixed literals from the fixture matrix.
    await db.query(`CREATE TEMP TABLE whatsapp_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name ${shape.domain || shape.body ? 'varchar(100)' : 'text'} NOT NULL,
      category text NOT NULL CHECK(category IN ('UTILITY','MARKETING','AUTHENTICATION')),
      language text NOT NULL DEFAULT 'es',
      status text NOT NULL DEFAULT 'BORRADOR'
        CHECK(status IN ('BORRADOR','EN_REVISION','APROBADA','RECHAZADA','DESHABILITADA')),
      components jsonb NOT NULL DEFAULT '[]',
      whatsapp_template_id text, waba_id text, rejection_reason text,
      usage_count integer NOT NULL DEFAULT 0, last_used_at timestamptz, created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      ${shape.domain ? ', domain varchar(50) NOT NULL' : ''}
      ${shape.body ? ', body text NOT NULL' : ''}
    ) ON COMMIT DROP;
    CREATE UNIQUE INDEX template_review_waba_name_language
      ON whatsapp_templates(waba_id,name,language) WHERE waba_id IS NOT NULL;
    CREATE UNIQUE INDEX template_review_legacy_name
      ON whatsapp_templates(name) WHERE waba_id IS NULL;
    CREATE TEMP TABLE cloud_numbers (
      waba_id text NOT NULL, phone_number_id text NOT NULL, whatsapp_line_id uuid,
      status text NOT NULL, token_expires_at timestamptz
    ) ON COMMIT DROP`)
    await db.query(`INSERT INTO cloud_numbers VALUES
      ('1111','1001',$1,'active',NULL), ('2222','2001',$2,'active',NULL)`, [lineA, lineB])
  }

  async function seed(shape: Shape, name: string, text: string, waba: string | null = null, metaId: string | null = null) {
    const columns = ['name', 'category', 'language', 'status', 'components', 'waba_id', 'whatsapp_template_id', 'usage_count']
    const values: unknown[] = [name, 'UTILITY', 'es_AR', waba ? 'APROBADA' : 'BORRADOR', JSON.stringify(bodyComponent(text)), waba, metaId, 7]
    if (shape.domain) { columns.push('domain'); values.push('historical_support') }
    if (shape.body) { columns.push('body'); values.push(text) }
    const binds = values.map((_, i) => `$${i + 1}`)
    return (await db.query<StoredRow>(`INSERT INTO whatsapp_templates (${columns.join(',')})
      VALUES (${binds.join(',')}) RETURNING *`, values)).rows[0]
  }
  async function stored(id: string) {
    return (await db.query<StoredRow>('SELECT * FROM whatsapp_templates WHERE id=$1', [id])).rows[0]
  }

  describe.each(shapes)('$label', shape => {
    it('creates and patches exact BODY content, preserves existing domain and unrelated rows', async () => {
      await fixture(shape)
      const historical = await seed(shape, 'historical_reference', 'Conservar el registro original.')
      const text = 'Estado del archivo "A".\nSolicitud {{1}}; referencia {{1}}.'
      const components = [{ type: 'BODY', text, example: { body_text: [['A-17']] } }]
      const created = await create(request('', 'POST', draft('  Solicitud  Registrada  ', components)))
      expect(created.status).toBe(201)
      const { id } = await created.json() as { id: string }
      const first = await stored(id)
      expect(first).toMatchObject({ name: 'solicitud_registrada', language: 'es_AR', components, waba_id: null, created_by: userId })
      if (shape.domain) {
        expect(first.domain).toBe('general')
        await db.query('UPDATE whatsapp_templates SET domain=$1 WHERE id=$2', ['custom_support', id])
      }
      if (shape.body) expect(first.body).toBe(text)
      expect(Object.hasOwn(first, 'domain')).toBe(shape.domain)
      expect(Object.hasOwn(first, 'body')).toBe(shape.body)

      const changedText = "La solicitud 'A-17' está actualizada.\nReferencia confirmada."
      expect((await patch(request(`/${id}`, 'PATCH', { components: bodyComponent(changedText) }), context(id))).status).toBe(200)
      expect((await patch(request(`/${id}`, 'PATCH', { name: 'Solicitud Ajustada' }), context(id))).status).toBe(200)
      const changed = await stored(id)
      expect(changed).toMatchObject({ name: 'solicitud_ajustada', components: bodyComponent(changedText) })
      if (shape.domain) expect(changed.domain).toBe('custom_support')
      if (shape.body) expect(changed.body).toBe(changedText)
      expect(await stored(historical.id)).toEqual(historical)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('upserts only the accessible WABA, preserves domains, and keeps languages independent', async () => {
      await fixture(shape)
      const local = await seed(shape, 'catalogue_notice', 'Borrador local.')
      const accountA = await seed(shape, 'catalogue_notice', 'Registro anterior A.', '1111', '8001')
      const accountB = await seed(shape, 'catalogue_notice', 'Registro anterior B.', '2222', '8002')
      const removed = await seed(shape, 'removed_notice', 'Registro ausente del catálogo.', '1111', '8003')
      const catalogue = [imported('9001', 'Estado actualizado A.'), imported('9002', 'Request recorded.', 'en')]
      mocks.list.mockResolvedValue(catalogue)
      const response = await sync(request('/sync-cloud', 'POST', { waba_id: '2222' }))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, synced: 2, accounts: 1 })
      expect(mocks.list).toHaveBeenCalledExactlyOnceWith('1111')
      expect(mocks.token).toHaveBeenCalledExactlyOnceWith('1001')
      const changedA = await stored(accountA.id)
      expect(changedA).toMatchObject({ whatsapp_template_id: '9001', components: catalogue[0].components, usage_count: 7 })
      if (shape.domain) expect(changedA.domain).toBe('historical_support')
      if (shape.body) expect(changedA.body).toBe('Estado actualizado A.')
      const english = (await db.query<StoredRow>("SELECT * FROM whatsapp_templates WHERE waba_id='1111' AND language='en'")).rows
      expect(english).toHaveLength(1)
      expect(english[0]).toMatchObject({ name: 'catalogue_notice', whatsapp_template_id: '9002', components: catalogue[1].components })
      if (shape.domain) expect(english[0].domain).toBe('general')
      if (shape.body) expect(english[0].body).toBe('Request recorded.')
      expect((await stored(removed.id)).status).toBe('DESHABILITADA')
      expect(await stored(accountB.id)).toEqual(accountB)
      expect(await stored(local.id)).toEqual(local)
      expect((await patch(request(`/${accountA.id}`, 'PATCH', { components: bodyComponent('Intento local.') }), context(accountA.id))).status).toBe(409)
      expect(await stored(accountA.id)).toEqual(changedA)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('returns validation errors before writes and handles a real uniqueness conflict', async () => {
      await fixture(shape)
      for (const payload of [draft('   '), draft('invalid/name'), draft('a'.repeat(101)), draft('missing_body', [])]) {
        mocks.query.mockClear()
        expect((await create(request('', 'POST', payload))).status).toBe(400)
        expect(mocks.query).not.toHaveBeenCalled()
      }
      const payload = draft('a'.repeat(100))
      expect((await create(request('', 'POST', payload))).status).toBe(201)
      await db.query('SAVEPOINT expected_duplicate')
      try {
        expect((await create(request('', 'POST', payload))).status).toBe(409)
      } finally {
        await db.query('ROLLBACK TO SAVEPOINT expected_duplicate')
        await db.query('RELEASE SAVEPOINT expected_duplicate')
      }
      expect((await db.query('SELECT count(*)::int AS count FROM whatsapp_templates')).rows).toEqual([{ count: 1 }])
    })
  })

  it('reproduces both historical NOT NULL failures when the legacy columns are omitted', async () => {
    await fixture(shapes[0])
    for (const [columns, values, column] of [
      ['name,category', ['old_insert', 'UTILITY'], 'domain'],
      ['name,category,domain', ['old_insert', 'UTILITY', 'general'], 'body'],
    ] as const) {
      await db.query('SAVEPOINT expected_not_null')
      try {
        const binds = values.map((_, i) => `$${i + 1}`).join(',')
        await expect(db.query(`INSERT INTO whatsapp_templates (${columns}) VALUES (${binds})`, [...values]))
          .rejects.toMatchObject({ code: '23502', column })
      } finally {
        await db.query('ROLLBACK TO SAVEPOINT expected_not_null')
        await db.query('RELEASE SAVEPOINT expected_not_null')
      }
    }
  })

  it('rolls back a failed WABA snapshot while preserving the successful account update', async () => {
    const shape = shapes[0]
    await fixture(shape)
    const accountA = await seed(shape, 'catalogue_notice', 'Conservar A.', '1111', '8001')
    const missingA = await seed(shape, 'other_notice', 'Conservar otro registro A.', '1111', '8003')
    const accountB = await seed(shape, 'catalogue_notice', 'Versión previa B.', '2222', '8002')
    mocks.access.mockResolvedValue([lineA, lineB])
    mocks.list.mockImplementation(async (waba: string) => waba === '1111'
      ? [imported('9001', 'Este cambio debe revertirse.'), { ...imported('9003', 'Dato inválido.'), name: 'invalid_category', category: 'INVALID' }]
      : [imported('9002', 'Versión actualizada B.')])
    const response = await sync(request('/sync-cloud', 'POST'))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ synced: 1, failed_accounts: 1 })
    expect(await stored(accountA.id)).toEqual(accountA)
    expect(await stored(missingA.id)).toEqual(missingA)
    expect(await stored(accountB.id)).toMatchObject({
      whatsapp_template_id: '9002', body: 'Versión actualizada B.', domain: 'historical_support',
    })
    expect((await db.query('SELECT count(*)::int AS count FROM whatsapp_templates')).rows).toEqual([{ count: 3 }])
    expect(fetch).not.toHaveBeenCalled()
  })
})
