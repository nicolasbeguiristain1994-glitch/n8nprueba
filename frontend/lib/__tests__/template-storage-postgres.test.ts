// @vitest-environment node
/**
 * Real SQL against a LOCAL PostgreSQL (RUN_TEMPLATE_PG_TESTS=1, DATABASE_URL on localhost).
 * Everything runs inside one transaction on TEMP tables and is rolled back.
 * The route handlers run unchanged; only @/lib/db is pointed at the test client.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  db: undefined as unknown as import('pg').Client,
  accounts: [] as Array<{ waba_id: string; phone_number_id: string }>,
}))
vi.mock('@/lib/db', () => ({
  query: async (sql: string, params?: unknown[]) =>
    sql.includes('FROM cloud_numbers') ? state.accounts : (await state.db.query(sql, params)).rows,
  // Nested in the outer test transaction: a savepoint gives the same commit/rollback semantics.
  withTransaction: async <T>(work: (client: unknown) => Promise<T>) => {
    await state.db.query('SAVEPOINT route_tx')
    try {
      const result = await work(state.db)
      await state.db.query('RELEASE SAVEPOINT route_tx')
      return result
    } catch (e) {
      await state.db.query('ROLLBACK TO SAVEPOINT route_tx')
      throw e
    }
  },
}))
const mocks = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/lib/permissions', () => ({
  checkPermissionWithUser: async () => ({ ok: true, user: { user_id: '00000000-0000-4000-8000-000000000001', role: 'admin', is_super_admin: true } }),
}))
vi.mock('@/lib/line-visibility', () => ({ getAccessibleLineIds: async () => null }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/security-log', () => ({ securityLog: vi.fn() }))
vi.mock('@/lib/cloud-api/token-store', () => ({ getTokenForNumber: async () => 'synthetic-token' }))
vi.mock('@/lib/cloud-api/client', () => ({ MetaCloudApiClient: class { listTemplates = mocks.list } }))

import { POST as create } from '@/app/api/templates/route'
import { PATCH as patch } from '@/app/api/templates/[id]/route'
import { POST as syncCloud } from '@/app/api/templates/sync-cloud/route'
import { detectLegacyTemplateColumns } from '@/lib/template-storage'

const migration131 = readFileSync(new URL('../../../db/migrations/131_campaign_template_scope.sql', import.meta.url), 'utf8')

// db/schema/init.sql (relevant columns, FKs omitted) + migration 039 ALTERs + 131.
const LEGACY_TABLE = `
  CREATE TEMP TABLE whatsapp_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    display_name VARCHAR(255),
    domain VARCHAR(50) NOT NULL,
    language VARCHAR(10) DEFAULT 'es',
    body TEXT NOT NULL,
    variables JSONB DEFAULT '[]'::JSONB,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  ALTER TABLE whatsapp_templates
    ADD COLUMN IF NOT EXISTS category             TEXT NOT NULL DEFAULT 'MARKETING',
    ADD COLUMN IF NOT EXISTS language             TEXT NOT NULL DEFAULT 'es',
    ADD COLUMN IF NOT EXISTS status               TEXT NOT NULL DEFAULT 'BORRADOR',
    ADD COLUMN IF NOT EXISTS components           JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS whatsapp_template_id TEXT,
    ADD COLUMN IF NOT EXISTS rejection_reason     TEXT,
    ADD COLUMN IF NOT EXISTS usage_count          INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_used_at         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS created_by           UUID;`

// Migration 039 table (FK omitted) + 131.
const MODERN_TABLE = `
  CREATE TEMP TABLE whatsapp_templates (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  TEXT        NOT NULL UNIQUE,
    category              TEXT        NOT NULL CHECK (category IN ('UTILITY','MARKETING','AUTHENTICATION')),
    language              TEXT        NOT NULL DEFAULT 'es',
    status                TEXT        NOT NULL DEFAULT 'BORRADOR'
                                      CHECK (status IN ('BORRADOR','EN_REVISION','APROBADA','RECHAZADA','DESHABILITADA')),
    components            JSONB       NOT NULL DEFAULT '[]'::jsonb,
    whatsapp_template_id  TEXT,
    rejection_reason      TEXT,
    usage_count           INTEGER     NOT NULL DEFAULT 0,
    last_used_at          TIMESTAMPTZ,
    created_by            UUID,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`

const json = (method: string, url: string, body: unknown) =>
  new NextRequest(`https://example.test${url}`, { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

const validDraft = {
  name: 'Aviso Soporte',
  category: 'UTILITY',
  language: 'es_AR',
  components: [
    { type: 'BODY', text: 'Hola {{1}}, tu consulta {{2}} fue registrada. Gracias {{1}}.', example: { body_text: [['Ana', 'A-100']] } },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver estado', url: 'https://example.test/soporte' }] },
  ],
}
const metaTemplate = (id: string, name: string, text: string | null, status = 'APPROVED') => ({
  id, name, status, language: 'es_AR', category: 'UTILITY',
  components: text === null ? [{ type: 'HEADER', format: 'TEXT', text: 'Soporte' }] : [{ type: 'BODY', text }],
})
const count = async () => Number((await state.db.query('SELECT count(*) FROM whatsapp_templates')).rows[0].count)
const byName = async (name: string) => (await state.db.query('SELECT * FROM whatsapp_templates WHERE name=$1', [name])).rows[0]

describe.skipIf(process.env.RUN_TEMPLATE_PG_TESTS !== '1')('Template writes on local PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    state.db = new Client({ connectionString: url.toString(), ssl: false })
    await state.db.connect()
    await state.db.query('BEGIN')
    // Migration 131 also indexes campaigns.
    await state.db.query('CREATE TEMP TABLE campaigns(id int, status text, scheduled_at timestamptz)')
  })
  afterAll(async () => { if (state.db) { await state.db.query('ROLLBACK'); await state.db.end() } })
  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
    mocks.list.mockReset()
    state.accounts = [{ waba_id: '1111', phone_number_id: '1001' }]
    await state.db.query('SAVEPOINT variant')
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await state.db.query('ROLLBACK TO SAVEPOINT variant')
  })

  describe('historical table (domain/body NOT NULL without defaults)', () => {
    beforeEach(async () => { await state.db.query(LEGACY_TABLE); await state.db.query(migration131) })

    it('detects the optional legacy columns', async () => {
      expect(await detectLegacyTemplateColumns(async (s, p) => (await state.db.query(s, p)).rows))
        .toEqual({ domain: true, body: true })
    })

    it('creates a valid template filling domain and body', async () => {
      const res = await create(json('POST', '/api/templates', validDraft))
      expect(res.status).toBe(201)
      const row = await byName('aviso_soporte')
      expect(row).toMatchObject({ id: (await res.json()).id, domain: 'general', language: 'es_AR', status: 'BORRADOR', body: validDraft.components[0].text })
      expect(row.components[0].example).toEqual({ body_text: [['Ana', 'A-100']] })
    })

    it.each([
      ['empty button text', { ...validDraft, components: [validDraft.components[0], { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: ' ' }] }] }],
      ['missing variable example', { ...validDraft, components: [{ type: 'BODY', text: 'Hola {{1}}' }] }],
      ['name with punctuation', { ...validDraft, name: 'aviso-soporte!' }],
    ])('rejects %s without writing', async (_label, body) => {
      const res = await create(json('POST', '/api/templates', body))
      expect(res.status).toBe(400)
      expect(await count()).toBe(0)
    })

    it('PATCH mirrors BODY into body and preserves the existing domain', async () => {
      const { rows: [row] } = await state.db.query(`INSERT INTO whatsapp_templates (name, domain, body, category, components)
        VALUES ('aviso_previo', 'support', 'Texto previo', 'UTILITY', '[{"type":"BODY","text":"Texto previo"}]') RETURNING id`)
      const components = [{ type: 'BODY', text: 'Texto actualizado para {{1}}', example: { body_text: [['Ana']] } }]
      expect((await patch(json('PATCH', `/api/templates/${row.id}`, { components }), params(row.id))).status).toBe(200)
      expect(await byName('aviso_previo')).toMatchObject({ domain: 'support', body: 'Texto actualizado para {{1}}', components })

      expect((await patch(json('PATCH', `/api/templates/${row.id}`, { status: 'BORRADOR', name: 'Aviso Previo 2' }), params(row.id))).status).toBe(200)
      expect(await byName('aviso_previo_2')).toMatchObject({ domain: 'support', body: 'Texto actualizado para {{1}}' })
    })

    it('sync inserts and updates the same WABA, preserving domain and disabling absent rows', async () => {
      await state.db.query(`INSERT INTO whatsapp_templates (name, domain, body, language, category, status, components, whatsapp_template_id, waba_id)
        VALUES ('aviso_catalogo', 'support', 'Texto viejo', 'es_AR', 'UTILITY', 'EN_REVISION', '[]', '9001', '1111'),
               ('aviso_retirado', 'support', 'Retirado', 'es_AR', 'UTILITY', 'APROBADA', '[]', '9009', '1111')`)
      mocks.list.mockResolvedValue([
        metaTemplate('9001', 'aviso_catalogo', 'Texto nuevo de soporte'),
        metaTemplate('9002', 'aviso_nuevo', 'Consulta registrada'),
        metaTemplate('9003', 'aviso_sin_cuerpo', null),
      ])
      const res = await syncCloud(json('POST', '/api/templates/sync-cloud', {}))
      expect(await res.json()).toEqual({ ok: true, synced: 3, accounts: 1 })
      expect(await byName('aviso_catalogo')).toMatchObject({ domain: 'support', body: 'Texto nuevo de soporte', status: 'APROBADA' })
      expect(await byName('aviso_nuevo')).toMatchObject({ domain: 'general', body: 'Consulta registrada', waba_id: '1111' })
      expect(await byName('aviso_sin_cuerpo')).toMatchObject({ domain: 'general', body: '' })
      expect((await byName('aviso_retirado')).status).toBe('DESHABILITADA')
    })

    it('rolls back the whole WABA snapshot when one provider row cannot be stored', async () => {
      await state.db.query(`INSERT INTO whatsapp_templates (name, domain, body, language, category, status, components, whatsapp_template_id, waba_id)
        VALUES ('aviso_catalogo', 'support', 'Texto viejo', 'es_AR', 'UTILITY', 'APROBADA', '[]', '9001', '1111')`)
      // Production keeps name VARCHAR(100); the schema is not widened.
      mocks.list.mockResolvedValue([metaTemplate('9001', 'aviso_catalogo', 'Texto nuevo'), metaTemplate('9002', 'x'.repeat(101), 'Texto')])
      const res = await syncCloud(json('POST', '/api/templates/sync-cloud', {}))
      expect(res.status).toBe(502)
      expect(await count()).toBe(1)
      expect(await byName('aviso_catalogo')).toMatchObject({ body: 'Texto viejo', status: 'APROBADA' })
    })
  })

  describe('modern table (migration 039 only)', () => {
    beforeEach(async () => { await state.db.query(MODERN_TABLE); await state.db.query(migration131) })

    it('detects no legacy columns in the same process (no cross-client cache)', async () => {
      expect(await detectLegacyTemplateColumns(async (s, p) => (await state.db.query(s, p)).rows))
        .toEqual({ domain: false, body: false })
    })

    it('creates, patches and syncs without legacy columns', async () => {
      const res = await create(json('POST', '/api/templates', validDraft))
      expect(res.status).toBe(201)
      const { id } = await res.json()
      const components = [{ type: 'BODY', text: 'Texto actualizado' }]
      expect((await patch(json('PATCH', `/api/templates/${id}`, { components }), params(id))).status).toBe(200)
      expect(await byName('aviso_soporte')).toMatchObject({ components })

      mocks.list.mockResolvedValue([metaTemplate('9002', 'aviso_nuevo', 'Consulta registrada')])
      expect((await syncCloud(json('POST', '/api/templates/sync-cloud', {}))).status).toBe(200)
      mocks.list.mockResolvedValue([metaTemplate('9002', 'aviso_nuevo', 'Consulta actualizada', 'REJECTED')])
      expect((await syncCloud(json('POST', '/api/templates/sync-cloud', {}))).status).toBe(200)
      expect(await byName('aviso_nuevo')).toMatchObject({ status: 'RECHAZADA', components: [{ type: 'BODY', text: 'Consulta actualizada' }] })
    })
  })
})
