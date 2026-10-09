// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
vi.mock('@/lib/db', () => ({ query: vi.fn(), withTransaction: vi.fn() }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
import { query, withTransaction } from '@/lib/db'
import { DELETE, GET, PATCH } from '@/app/api/users/[id]/route'
import { GET as listUsers } from '@/app/api/users/route'
import { checkSessionWithUser } from '@/lib/permissions'
import { lockManagedUser, protectLastAdmin } from '@/lib/user-management'
import { makeAdminSession, makeSession, makeReqWithSession, TEST_AUTH_SECRET } from './helpers/session'

describe.skipIf(!process.env.OPS_TEST_DATABASE_URL)('user deletion with PostgreSQL and real permission checks', () => {
  let pool: Pool
  const schema = 'users_delete_' + randomUUID().replaceAll('-', '')
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const session = (n: number) => makeAdminSession({ user_id: id(n) })
  const request = (n: number, target: number, method = 'DELETE', body?: unknown) => makeReqWithSession(
    `http://localhost/api/users/${id(target)}`, session(n), { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) })
  const params = (n: number) => ({ params: Promise.resolve({ id: id(n) }) })
  beforeAll(async () => {
    const url = new URL(process.env.OPS_TEST_DATABASE_URL!)
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw Error('Local PostgreSQL required')
    pool = new Pool({ connectionString: url.toString(), max: 5, options: `-c search_path=${schema},pg_catalog` })
    await pool.query(`CREATE SCHEMA ${schema}; CREATE TYPE user_role AS ENUM ('admin','operator','viewer');
      CREATE TABLE users(id uuid PRIMARY KEY,email text UNIQUE,name text,role user_role,sectors jsonb DEFAULT '[]',
        is_active boolean NOT NULL DEFAULT true,session_version int DEFAULT 1,created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),last_login_at timestamptz,can_download_contacts boolean DEFAULT true,
        allowed_agents text[] DEFAULT '{}',is_super_admin boolean DEFAULT false,password_hash text);
      CREATE TABLE owned_history(owner_id uuid REFERENCES users(id),description text)`)
    await pool.query(fs.readFileSync(path.resolve('../db/migrations/150_users_soft_delete.sql'), 'utf8').replaceAll('public.', schema + '.'))
    vi.mocked(query).mockImplementation(async (sql, values) => (await pool.query(sql, values)).rows)
    vi.mocked(withTransaction).mockImplementation(async callback => {
      const client = await pool.connect()
      try { await client.query('BEGIN'); const value = await callback(client); await client.query('COMMIT'); return value }
      catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    })
    vi.stubEnv('AUTH_SECRET', TEST_AUTH_SECRET)
  })
  beforeEach(async () => {
    await pool.query(`TRUNCATE owned_history,users CASCADE;
      INSERT INTO users(id,email,name,role,is_active) VALUES
      ('${id(1)}','admin1@example.test','Admin uno','admin',true),
      ('${id(2)}','admin2@example.test','Admin dos','admin',true),
      ('${id(3)}','operator@example.test','Operador','operator',true),
      ('${id(4)}','inactive@example.test','Inactivo','viewer',false);
      INSERT INTO owned_history VALUES ('${id(3)}','Historical campaign')`)
  })
  afterAll(async () => { vi.unstubAllEnvs(); if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end() } })

  it('removes the user from results, preserves history and immediately revokes existing sessions', async () => {
    const prior = makeReqWithSession('http://localhost/api/auth/me', makeSession({ user_id: id(3) }))
    expect((await checkSessionWithUser(prior)).ok).toBe(true)
    expect((await DELETE(request(1,3), params(3))).status).toBe(200)
    const stored = (await pool.query('SELECT * FROM users WHERE id=$1', [id(3)])).rows[0]
    expect(stored).toMatchObject({ is_active: false, session_version: 2, deleted_by: id(1) })
    expect(stored.deleted_at).not.toBeNull()
    expect((await pool.query('SELECT * FROM owned_history')).rowCount).toBe(1)
    expect((await checkSessionWithUser(prior)).ok).toBe(false)
    const list = await (await listUsers(makeReqWithSession('http://localhost/api/users',session(1)))).json()
    expect(list.pagination.total).toBe(3)
    expect(list.users.map((u: { id: string }) => u.id)).not.toContain(id(3))
    expect(list.users.map((u: { id: string }) => u.id)).toContain(id(4))
    const searched = await (await listUsers(makeReqWithSession('http://localhost/api/users?search=operator',session(1)))).json()
    expect(searched.users).toEqual([]); expect(searched.pagination.total).toBe(0)
    expect((await GET(request(1,3,'GET'), params(3))).status).toBe(404)
    expect((await PATCH(request(1,3,'PATCH',{ is_active: true }), params(3))).status).toBe(404)
    await expect(pool.query('UPDATE users SET is_active=true WHERE id=$1',[id(3)])).rejects.toMatchObject({ code: '23514' })
  })

  it('allows removing inactive users, rejects self-deletion, operators and anonymous requests', async () => {
    expect((await DELETE(request(1,4),params(4))).status).toBe(200)
    expect((await DELETE(request(1,1),params(1))).status).toBe(400)
    // The cookie claims admin, but authorization must use the stored operator role.
    expect((await DELETE(request(3,2),params(2))).status).toBe(403)
    expect((await DELETE(new Request('http://localhost/api/users/'+id(2),{ method:'DELETE' }),params(2))).status).toBe(401)
  })

  it('keeps an active admin when simultaneous deletions or role changes compete', async () => {
    const results = await Promise.all([
      DELETE(request(1,2),params(2)),
      PATCH(request(2,1,'PATCH',{ role:'viewer' }),params(1)),
    ])
    expect(results.filter(r=>r.status===200)).toHaveLength(1)
    expect(results.every(r=>[200,400,401].includes(r.status))).toBe(true)
    expect((await pool.query("SELECT count(*)::int n FROM users WHERE role='admin' AND is_active=true")).rows[0].n).toBe(1)
  })

  it('checks the final admin inside the transaction and cannot reactivate a concurrently deleted account', async () => {
    await pool.query('UPDATE users SET is_active=false WHERE id=$1',[id(2)])
    await expect(withTransaction(async client => protectLastAdmin(client,await lockManagedUser(client,id(1)),true)))
      .rejects.toMatchObject({ status:400 })
    const results = await Promise.all([
      DELETE(request(1,3),params(3)), PATCH(request(1,3,'PATCH',{ is_active:true }),params(3)),
    ])
    expect(results[0].status).toBe(200)
    expect([200,404]).toContain(results[1].status)
    expect((await pool.query('SELECT is_active,deleted_at FROM users WHERE id=$1',[id(3)])).rows[0])
      .toMatchObject({ is_active:false, deleted_at:expect.any(Date) })
  })
})
