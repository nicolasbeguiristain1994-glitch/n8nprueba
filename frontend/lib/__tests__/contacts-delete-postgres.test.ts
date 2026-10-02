// @vitest-environment node
import { afterAll, beforeAll, expect, it, describe, vi } from 'vitest'
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
import { DELETE } from '@/app/api/contacts/[id]/route'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
describe.skipIf(process.env.RUN_CONTACT_DELETE_PG_TESTS !== '1')('contact deletion preserves line usage history', () => {
  let db: Client
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    db = new Client({ connectionString: url.toString(), ssl: false })
    await db.connect()
    await db.query(`BEGIN; CREATE SCHEMA contact_delete_${process.pid}; SET LOCAL search_path=contact_delete_${process.pid};
      CREATE TABLE contacts(id uuid PRIMARY KEY);
      CREATE TABLE campaign_recipients(id uuid PRIMARY KEY,contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE);
      CREATE TABLE line_usage_log(id uuid PRIMARY KEY,recipient_id uuid REFERENCES campaign_recipients(id),status text,created_at timestamptz);
      CREATE TABLE whatsapp_messages(id uuid PRIMARY KEY,contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,body text);`)
    mocks.query.mockImplementation(async (sql, values) => (await db.query(sql, values)).rows)
    mocks.auth.mockResolvedValue({ ok: true, user: { role: 'admin', user_id: id(99) } })
    for (let n = 1; n <= 12; n++) {
      await db.query('INSERT INTO contacts VALUES($1)', [id(n)])
      await db.query('INSERT INTO campaign_recipients VALUES($1,$1)', [id(n)])
      await db.query("INSERT INTO line_usage_log VALUES($1,$1,'sent','2026-10-01T12:00:00Z')", [id(n)])
      await db.query("INSERT INTO whatsapp_messages VALUES($1,$1,'Historical message')", [id(n)])
    }
  })
  afterAll(async () => { if (db) { await db.query('ROLLBACK'); await db.end() } })
  it('reproduces the production constraint error, applies the migration, and deletes 11 selected fixtures', async () => {
    await db.query('SAVEPOINT before_failure')
    await expect(db.query('DELETE FROM contacts WHERE id=$1', [id(1)])).rejects.toMatchObject({ code: '23503', constraint: 'line_usage_log_recipient_id_fkey' })
    await db.query('ROLLBACK TO SAVEPOINT before_failure')
    const migration = readFileSync('../db/migrations/140_contact_delete_usage_history.sql', 'utf8')
    await db.query(migration)
    await db.query(migration) // safe to apply again
    for (let n = 1; n <= 11; n++) {
      const result = await DELETE(new NextRequest(`http://localhost/api/contacts/${id(n)}`, { method: 'DELETE' }), { params: Promise.resolve({ id: id(n) }) })
      expect(result.status).toBe(200)
    }
    expect((await db.query('SELECT id FROM contacts')).rows).toEqual([{ id: id(12) }])
    expect((await db.query('SELECT id FROM campaign_recipients')).rows).toEqual([{ id: id(12) }])
    const logs = (await db.query('SELECT * FROM line_usage_log ORDER BY id')).rows
    expect(logs).toHaveLength(12)
    expect(logs.slice(0, 11).every(row => row.recipient_id === null && row.status === 'sent' && row.created_at.toISOString() === '2026-10-01T12:00:00.000Z')).toBe(true)
    expect(logs[11].recipient_id).toBe(id(12))
    const messages = (await db.query('SELECT * FROM whatsapp_messages ORDER BY id')).rows
    expect(messages).toHaveLength(12)
    expect(messages.slice(0, 11).every(row => row.contact_id === null && row.body === 'Historical message')).toBe(true)
  })
  it('continues to enforce permissions and reject invalid identifiers', async () => {
    mocks.auth.mockResolvedValueOnce({ ok: false, response: Response.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await DELETE(new NextRequest('http://localhost/api/contacts'), { params: Promise.resolve({ id: id(12) }) })).status).toBe(403)
    expect((await DELETE(new NextRequest('http://localhost/api/contacts'), { params: Promise.resolve({ id: 'invalid' }) })).status).toBe(400)
    expect((await db.query('SELECT id FROM contacts')).rows).toEqual([{ id: id(12) }])
  })
})
