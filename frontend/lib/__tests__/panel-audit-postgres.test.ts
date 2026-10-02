// @vitest-environment node
// Real SQL, exclusively against temporary tables on a local database.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth }))
import { GET as campaigns } from '@/app/api/stats/campaigns/route'
import { GET as logs } from '@/app/api/automations/logs/route'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const req = (path: string) => new NextRequest('http://localhost/api/' + path)

describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS !== '1')('panel statistics and automation history on PostgreSQL', () => {
  let db: Client
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    db = new Client({ connectionString: url.toString(), ssl: false })
    await db.connect()
    await db.query(`BEGIN;
      CREATE TEMP TABLE campaigns(id uuid PRIMARY KEY, owned_by uuid, name text, type text, status text, created_at timestamptz, completed_at timestamptz);
      CREATE TYPE pg_temp.audit_campaign_status AS ENUM ('draft','sending','completed','cancelled');
      ALTER TABLE campaigns ALTER status TYPE pg_temp.audit_campaign_status USING status::pg_temp.audit_campaign_status;
      CREATE TEMP TABLE whatsapp_messages(id uuid, campaign_id uuid, direction text, status text, created_at timestamptz, phone_number text, template_id uuid);
      CREATE TEMP TABLE campaign_recipients(campaign_id uuid,phone_number text,status text);
      CREATE TEMP TABLE automation_logs(id uuid, automation_id uuid, automation_name text, conversation_phone text, message_id text, result text, details text, created_at timestamptz);
      INSERT INTO campaigns VALUES('${id(1)}','${id(10)}','Own','broadcast','completed','2026-09-30',NULL),('${id(2)}','${id(20)}','Other','broadcast','draft','2026-09-30',NULL);
      INSERT INTO whatsapp_messages VALUES('${id(100)}','${id(1)}','outbound','delivered','2026-09-30','+5491100000001',NULL);
      INSERT INTO campaign_recipients VALUES('${id(1)}','+5491100000001','sent');
      INSERT INTO automation_logs SELECT md5(n::text)::uuid,'${id(5)}','Audit','test',NULL,CASE WHEN n%2=0 THEN 'executed' ELSE 'error' END,NULL,'2026-09-30'::timestamptz+n*interval '1 second' FROM generate_series(1,55)n;`)
    let queue: Promise<unknown> = Promise.resolve()
    mocks.query.mockImplementation((sql, params) => {
      const next = queue.then(() => db.query(sql, params))
      queue = next.catch(() => undefined)
      return next.then(r => r.rows)
    })
  })
  beforeEach(() => { mocks.auth.mockResolvedValue({ ok: true, user: { role: 'admin', user_id: id(10) } }) })
  afterAll(async () => { if (db) { await db.query('ROLLBACK'); await db.end() } })
  const period = 'stats/campaigns?from=2026-09-29&to=2026-09-30'
  it('lists a real enum column without trying to cast an empty status to the enum', async () => {
    const res = await campaigns(req(period))
    expect(res.status).toBe(200)
    expect((await res.json()).campaigns).toHaveLength(2)
    const filtered = await (await campaigns(req(period + '&status=completed&q=Own'))).json()
    expect(filtered.campaigns).toHaveLength(1)
    expect(filtered.campaigns[0]).toMatchObject({ id: id(1), entregados: 1 })
  })
  it('enforces campaign ownership on list and direct detail', async () => {
    mocks.auth.mockResolvedValue({ ok: true, user: { role: 'operator', user_id: id(10) } })
    expect((await (await campaigns(req(period))).json()).campaigns).toHaveLength(1)
    expect((await campaigns(req(period + '&id=' + id(1)))).status).toBe(200)
    expect((await campaigns(req(period + '&id=' + id(2)))).status).toBe(404)
  })
  it('rejects malformed IDs and dates before querying', async () => {
    const count = mocks.query.mock.calls.length
    for (const path of [period + '&id=invalid', 'stats/campaigns?from=2026-02-30&to=2026-03-01']) expect((await campaigns(req(path))).status).toBe(400)
    expect(mocks.query.mock.calls.length).toBe(count)
  })
  it('loads history with stable pagination and matching filtered total', async () => {
    const first = await (await logs(req('automations/logs'))).json()
    const second = await (await logs(req('automations/logs?page=2'))).json()
    expect(first.logs).toHaveLength(50)
    expect(first.total).toBe(55)
    expect(second.logs).toHaveLength(5)
    expect(new Set([...first.logs, ...second.logs].map(r => r.id)).size).toBe(55)
    const filtered = await (await logs(req('automations/logs?result=executed&automation_id=' + id(5)))).json()
    expect(filtered.total).toBe(27)
    expect(filtered.logs.every((r: { result: string }) => r.result === 'executed')).toBe(true)
  })
  it('rejects invalid history filters and page', async () => {
    const count = mocks.query.mock.calls.length
    for (const suffix of ['page=abc','page=-1','page=1.5','automation_id=bad','result=invalid']) expect((await logs(req('automations/logs?' + suffix))).status).toBe(400)
    expect(mocks.query.mock.calls.length).toBe(count)
  })
  it('does not read either module for a denied user', async () => {
    mocks.auth.mockResolvedValue({ ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) })
    const count = mocks.query.mock.calls.length
    expect((await campaigns(req(period))).status).toBe(403)
    expect((await logs(req('automations/logs'))).status).toBe(403)
    expect(mocks.query.mock.calls.length).toBe(count)
  })
})
