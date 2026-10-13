/** @vitest-environment node */
import { Client } from 'pg'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const state = vi.hoisted(() => ({ db: null as unknown as Client, ids: null as string[] | null }))
vi.mock('@/lib/db', () => ({ query: async (sql: string, values?: unknown[]) => (await state.db.query(sql, values)).rows }))
vi.mock('@/lib/line-visibility', () => ({ getAccessibleLineIds: async () => state.ids }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: async () => ({ ok: true, user: { user_id: '00000000-0000-4000-8000-000000000001', role: 'admin' } }) }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
import { listTemplateAccounts, templateAccountNumber } from '@/lib/template-accounts'
import { POST as copy } from '@/app/api/templates/[id]/copy/route'
import { GET } from '@/app/api/templates/route'
import type { SessionUser } from '@/lib/auth'
const user = {} as SessionUser
const sourceId = '00000000-0000-4000-8000-000000000010'
const lineA = '00000000-0000-4000-8000-000000000011'
const lineB = '00000000-0000-4000-8000-000000000012'
const url = process.env.CONTACTS_TEST_DATABASE_URL
const request = (waba: string, name = 'descuento_20') => new NextRequest('https://example.test/api/templates/copy', { method: 'POST', body: JSON.stringify({ waba_id: waba, name }) })
describe.skipIf(!url)('Template accounts on local PostgreSQL', () => {
  beforeAll(async () => {
    if (!['localhost','127.0.0.1'].includes(new URL(url!).hostname)) throw Error('LOCAL_ONLY')
    state.db = new Client({ connectionString: url, ssl: false }); await state.db.connect(); await state.db.query('BEGIN')
    await state.db.query(`CREATE TEMP TABLE whatsapp_lines(id uuid, name text);
      CREATE TEMP TABLE cloud_numbers(waba_id text,phone_number_id text,whatsapp_line_id uuid,status text,verified_name text,token_expires_at timestamptz);
      CREATE TEMP TABLE whatsapp_templates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,category text,language text,components jsonb,
        status text NOT NULL DEFAULT 'BORRADOR',waba_id text,whatsapp_template_id text,usage_count int DEFAULT 0,rejection_reason text,
        last_used_at timestamptz,created_by uuid,created_at timestamptz DEFAULT NOW(),updated_at timestamptz DEFAULT NOW());
      CREATE UNIQUE INDEX templates_account_identity ON whatsapp_templates(waba_id,name,language) WHERE waba_id IS NOT NULL;`)
    await state.db.query(`INSERT INTO whatsapp_lines VALUES ($1,'Nexus'),($2,'Lexora')`, [lineA,lineB])
    await state.db.query(`INSERT INTO cloud_numbers VALUES ('11111','10001',$1,'active','Nexus',NULL),('22222','20001',$2,'active','Lexora',NULL)`,[lineA,lineB])
    await state.db.query(`INSERT INTO whatsapp_templates(id,name,category,language,components,status,waba_id,whatsapp_template_id,usage_count)
      VALUES ($1,'descuento_20','MARKETING','es','[{"type":"BODY","text":"20% de descuento"}]','APROBADA','11111','90001',12)`,[sourceId])
  })
  afterAll(async () => { if (state.db) { await state.db.query('ROLLBACK'); await state.db.end() } })
  it('returns distinct accounts and enforces line visibility on destination credentials', async () => {
    state.ids = null
    expect((await listTemplateAccounts(user)).map(a => a.name)).toEqual(['Lexora','Nexus'])
    state.ids = [lineA]
    expect(await listTemplateAccounts(user)).toMatchObject([{ waba_id: '11111', line_count: 1, connected: true }])
    expect(await templateAccountNumber(user,'22222')).toBeNull()
    expect(await templateAccountNumber(user,'11111')).toBe('10001')
  })
  it('copies approved content as a new independent draft and preserves source history', async () => {
    state.ids = null
    const res = await copy(request('22222'), { params: Promise.resolve({ id: sourceId }) })
    expect(res.status).toBe(201)
    const rows = (await state.db.query('SELECT * FROM whatsapp_templates ORDER BY waba_id')).rows
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ status:'APROBADA',whatsapp_template_id:'90001',usage_count:12 })
    expect(rows[1]).toMatchObject({ status:'BORRADOR',whatsapp_template_id:null,usage_count:0,waba_id:'22222' })
    expect(rows[1].components).toEqual(rows[0].components)
    const filtered = await GET(new NextRequest('https://example.test/api/templates?waba_id=22222'))
    expect((await filtered.json()).templates.map((t: {waba_id: string}) => t.waba_id)).toEqual(['22222'])
  })
  it('prevents duplicate overwrite within a destination account', async () => {
    await state.db.query('SAVEPOINT duplicate_copy')
    const res = await copy(request('22222'), { params: Promise.resolve({ id: sourceId }) })
    expect(res.status).toBe(409)
    await state.db.query('ROLLBACK TO SAVEPOINT duplicate_copy')
    expect((await state.db.query('SELECT count(*)::int AS n FROM whatsapp_templates')).rows[0].n).toBe(2)
  })
})
