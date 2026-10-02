// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: mocks.auth }))
import { dashboardMessageStats } from '@/lib/dashboard-messages'
import { GET as crm } from '@/app/api/dashboard/crm/route'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe.skipIf(process.env.RUN_DASHBOARD_PG_TESTS !== '1')('dashboard message metrics and CRM visibility', () => {
  let db: Client
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    db = new Client({ connectionString: url.toString(), ssl: false }); await db.connect()
    await db.query(`BEGIN; CREATE SCHEMA dashboard_metrics_${process.pid}; SET LOCAL search_path=dashboard_metrics_${process.pid};
      CREATE TABLE campaigns(id uuid,owned_by uuid);
      CREATE TABLE whatsapp_messages(id uuid,campaign_id uuid,template_id uuid,phone_number text,direction text,status text,created_at timestamptz,evolution_message_id text,whatsapp_message_id text);
      CREATE TABLE cloud_messages(id uuid,campaign_id uuid,conversation_id uuid,phone_number_id text,direction text,status text,sent_at timestamptz,created_at timestamptz,template_name text,content jsonb,wamid text);
      CREATE TABLE cloud_conversations(id uuid,contact_phone text);
      CREATE TABLE cloud_numbers(phone_number_id text,waba_id text);
      CREATE TABLE whatsapp_templates(id uuid,name text,waba_id text,created_at timestamptz);
      CREATE TABLE contacts(id uuid,phone_number text,first_name text,last_name text,created_at timestamptz,deleted_at timestamptz,panel text);
      CREATE TABLE operator_contact_visibility(operator_id uuid,contact_id uuid);
      CREATE TABLE tasks(id uuid,title text,due_date timestamptz,priority text,status text,deleted_at timestamptz,updated_at timestamptz);
      CREATE TABLE task_assignees(task_id uuid,user_id uuid);
      CREATE TABLE users(id uuid,name text,email text);
      INSERT INTO campaigns VALUES('${id(1)}','${id(10)}'),('${id(2)}','${id(20)}');
      INSERT INTO contacts VALUES('${id(70)}','5491100000001','Visible',NULL,NOW(),NULL,'royal'),('${id(71)}','5491100000002','Hidden','Contact',NOW(),NULL,'bigwin'),('${id(72)}','5491100000003','Deleted',NULL,NOW(),NOW(),'royal');
      INSERT INTO operator_contact_visibility VALUES('${id(10)}','${id(70)}'),('${id(10)}','${id(72)}');
      INSERT INTO cloud_numbers VALUES('phone','waba'); INSERT INTO cloud_conversations VALUES('${id(80)}','+5491100000001');
      INSERT INTO whatsapp_messages(id,campaign_id,phone_number,direction,status,created_at,evolution_message_id) VALUES
        ('${id(100)}','${id(1)}','+5491100000001','outbound','failed',NOW()-INTERVAL '3 hours',NULL),
        ('${id(101)}','${id(1)}','+5491100000001','outbound','read',NOW()-INTERVAL '1 hour','mirror'),
        ('${id(102)}',NULL,'+5491100000001','outbound','failed',NOW()-INTERVAL '30 minutes',NULL),
        ('${id(103)}',NULL,'+5491100000001','outbound','queued',NOW()-INTERVAL '20 minutes',NULL),
        ('${id(104)}',NULL,'+5491100000001','outbound','sent',NOW()-INTERVAL '25 hours',NULL),
        ('${id(105)}',NULL,'+5491100000001','outbound','read',NOW()-INTERVAL '31 days',NULL),
        ('${id(106)}','${id(2)}','+5491100000002','outbound','read',NOW()-INTERVAL '1 hour',NULL);
      INSERT INTO cloud_messages(id,conversation_id,phone_number_id,direction,status,sent_at,created_at,wamid) VALUES
        ('${id(107)}','${id(80)}','phone','outbound','read',NOW()-INTERVAL '1 hour',NOW(),'mirror'),
        ('${id(108)}','${id(80)}','phone','outbound','delivered',NOW()-INTERVAL '2 hours',NOW(),'manual'),
        ('${id(109)}','${id(80)}','phone','inbound','delivered',NOW()-INTERVAL '1 hour',NOW(),'reply');
      INSERT INTO users VALUES('${id(10)}','Assigned','assigned@example.test');
      INSERT INTO tasks VALUES('${id(30)}','Visible task',NOW()-INTERVAL '1 day','alta','pendiente',NULL,NOW()),('${id(31)}','Other task',NULL,'media','en_progreso',NULL,NOW()),('${id(32)}','Deleted task',NULL,'alta','pendiente',NOW(),NOW());
      INSERT INTO task_assignees VALUES('${id(30)}','${id(10)}'),('${id(32)}','${id(10)}');`)
    mocks.query.mockImplementation(async (sql, params) => (await db.query(sql, params)).rows)
  })
  afterAll(async () => { if (db) { await db.query('ROLLBACK'); await db.end() } })
  it('counts successful 24-hour sends, Cloud replies and inclusive delivery stages without duplicate attempts', async () => {
    expect(await dashboardMessageStats(null)).toEqual({ total: 7, sent: 4, delivered: 3, read: 2, failed: 1, inbound: 1, last_24h: 3, read_rate: 50 })
  })
  it('keeps campaign ownership and visible manual contacts in message metrics', async () => {
    expect(await dashboardMessageStats(id(10))).toMatchObject({ total: 6, sent: 3, read: 1, failed: 1, inbound: 1, last_24h: 2, read_rate: 33.3 })
    expect(await dashboardMessageStats(id(20))).toMatchObject({ total: 1, sent: 1, last_24h: 1, inbound: 0, read_rate: 100 })
    expect(await dashboardMessageStats(id(99))).toMatchObject({ total: 0, sent: 0, last_24h: 0, read_rate: 0 })
  })
  it('scopes CRM counts and lists to assignments and excludes deleted contacts and tasks', async () => {
    mocks.auth.mockResolvedValue({ ok: true, user: { role: 'operator', user_id: id(10), sectors: ['dashboard','contacts','tasks'], allowed_agents: ['royal'] } })
    const response = await crm(new NextRequest('http://localhost/')); expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.kpis).toEqual({ contacts: 1, tasks_pending: 1, tasks_overdue: 1 })
    expect(data.tasks.map((t: { title: string }) => t.title)).toEqual(['Visible task'])
    expect(data.recent_activity.map((a: { title: string }) => a.title)).toEqual(['Visible'])
  })
  it('does not disclose contacts or tasks without their sector permissions', async () => {
    mocks.auth.mockResolvedValue({ ok: true, user: { role: 'operator', user_id: id(10), sectors: ['dashboard'], allowed_agents: [] } })
    const data = await (await crm(new NextRequest('http://localhost/'))).json()
    expect(data.kpis).toEqual({ contacts: 0, tasks_pending: 0, tasks_overdue: 0 }); expect(data.tasks).toEqual([]); expect(data.recent_activity).toEqual([])
  })
  it('keeps active workspace totals for administrators', async () => {
    mocks.auth.mockResolvedValue({ ok: true, user: { role: 'admin', user_id: id(1) } })
    const data = await (await crm(new NextRequest('http://localhost/'))).json()
    expect(data.kpis).toEqual({ contacts: 2, tasks_pending: 2, tasks_overdue: 1 }); expect(data.tasks).toHaveLength(2)
  })
})
