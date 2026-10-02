// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), auth: vi.fn(), session: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth }))
vi.mock('@/lib/auth', () => ({ getSessionFromRequest: mocks.session }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/notify', () => ({ notify: vi.fn(), notifyMany: vi.fn() }))
import { GET as tasks, POST as createTask } from '@/app/api/tasks/route'
import { GET as taskDetail, DELETE as deleteTask } from '@/app/api/tasks/[id]/route'
import { POST as restoreTask } from '@/app/api/tasks/[id]/restore/route'
import { POST as taskStatus } from '@/app/api/tasks/[id]/status/route'
import { GET as calendar, POST as createEntry } from '@/app/api/marketing-calendar/route'
import { PUT as updateEntry, DELETE as deleteEntry } from '@/app/api/marketing-calendar/[id]/route'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const user = (n = 1, role = 'admin') => ({ user_id: id(n), role, name: 'Local audit', email: 'audit@example.invalid' })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const req = (path: string, body?: object, method = 'POST') => new NextRequest('http://localhost/api/' + path, body ? { method, body: JSON.stringify(body) } : undefined)

describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS !== '1')('task and calendar workflows on local PostgreSQL', () => {
  let db: Client
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    db = new Client({ connectionString: url.toString(), ssl: false }); await db.connect()
    await db.query(`BEGIN; CREATE SCHEMA panel_audit_${process.pid}; SET LOCAL search_path=panel_audit_${process.pid};
      CREATE TABLE users(id uuid PRIMARY KEY, name text,email text);
      INSERT INTO users VALUES('${id(1)}','Admin','admin@example.invalid'),('${id(2)}','Operator','operator@example.invalid'),('${id(3)}','Other','other@example.invalid')`)
    for (const name of ['045_tasks.sql','046_tasks_soft_delete.sql','marketing_calendar.sql']) await db.query(readFileSync('../db/migrations/' + name, 'utf8'))
    mocks.query.mockImplementation(async (sql, params) => (await db.query(sql, params)).rows)
    mocks.transaction.mockImplementation(async fn => {
      await db.query('SAVEPOINT route_tx')
      try { const result = await fn(db); await db.query('RELEASE SAVEPOINT route_tx'); return result }
      catch (err) { await db.query('ROLLBACK TO SAVEPOINT route_tx'); throw err }
    })
  })
  beforeEach(async () => {
    await db.query('TRUNCATE tasks,task_assignees,task_logs,marketing_calendar')
    mocks.auth.mockResolvedValue({ ok: true, user: user() }); mocks.session.mockReturnValue(user())
  })
  afterAll(async () => { if (db) { await db.query('ROLLBACK'); await db.end() } })
  async function task() {
    const r = await createTask(req('tasks', { title: 'Local task', assignees: [id(2)], type: 'otro', scheduled_at: '2026-09-30T15:00:00-03:00' }))
    expect(r.status).toBe(201); return (await r.json()).id as string
  }
  it('creates an assigned task and records allowed progress/completion transitions', async () => {
    const taskId = await task()
    expect((await (await tasks(req('tasks'))).json()).total).toBe(1)
    mocks.auth.mockResolvedValue({ ok: true, user: user(2,'operator') })
    expect((await taskStatus(req('tasks', { status: 'completada' }),ctx(taskId))).status).toBe(400)
    for (const status of ['en_progreso','completada']) expect((await taskStatus(req('tasks',{status}),ctx(taskId))).status).toBe(200)
    const detail = await (await taskDetail(req('tasks'),ctx(taskId))).json()
    expect(detail.task.status).toBe('completada')
    expect(detail.logs.map((l: { action: string }) => l.action)).toEqual(['creada','iniciada','completada'])
  })
  it('denies an unassigned operator and preserves data through delete/restore', async () => {
    const taskId = await task()
    mocks.auth.mockResolvedValue({ ok: true, user: user(3,'operator') })
    expect((await taskDetail(req('tasks'),ctx(taskId))).status).toBe(403)
    expect((await taskStatus(req('tasks',{status:'en_progreso'}),ctx(taskId))).status).toBe(403)
    mocks.auth.mockResolvedValue({ ok: true, user: user() })
    expect((await deleteTask(req('tasks'),ctx(taskId))).status).toBe(200)
    expect((await (await tasks(req('tasks'))).json()).total).toBe(0)
    expect((await restoreTask(req('tasks'),ctx(taskId))).status).toBe(200)
    expect((await (await taskDetail(req('tasks'),ctx(taskId))).json()).task.title).toBe('Local task')
  })
  it('creates and reschedules the owner’s calendar entry; admin removes it', async () => {
    mocks.session.mockReturnValue(user(2,'operator')); mocks.auth.mockResolvedValue({ok:true,user:user(2,'operator')})
    const r = await createEntry(req('marketing-calendar',{title:'Local calendar',date:'2026-09-30',hour:15}))
    expect(r.status).toBe(201); const entryId = (await r.json()).entry.id
    expect((await (await calendar(req('marketing-calendar?start=2026-09-30&end=2026-09-30'))).json()).entries).toHaveLength(1)
    mocks.session.mockReturnValue(user(3,'operator')); mocks.auth.mockResolvedValue({ok:true,user:user(3,'operator')})
    expect((await deleteEntry(req('marketing-calendar'),ctx(entryId))).status).toBe(403)
    mocks.session.mockReturnValue(user(2,'operator')); mocks.auth.mockResolvedValue({ok:true,user:user(2,'operator')})
    expect((await updateEntry(req('marketing-calendar',{title:'Rescheduled',date:'2026-10-01',hour:10},'PUT'),ctx(entryId))).status).toBe(200)
    expect((await (await calendar(req('marketing-calendar?start=2026-09-30&end=2026-09-30'))).json()).entries).toHaveLength(0)
    mocks.auth.mockResolvedValue({ok:true,user:user()})
    expect((await deleteEntry(req('marketing-calendar'),ctx(entryId))).status).toBe(200)
  })
  it('keeps calendar mutations unavailable to viewers', async () => {
    mocks.session.mockReturnValue(user(3,'viewer')); mocks.auth.mockResolvedValue({ok:false,response:Response.json({error:'Forbidden'},{status:403})})
    expect((await createEntry(req('marketing-calendar',{title:'Denied',date:'2026-09-30'}))).status).toBe(403)
    expect((await db.query('SELECT COUNT(*)::int AS n FROM marketing_calendar')).rows[0].n).toBe(0)
  })
})
