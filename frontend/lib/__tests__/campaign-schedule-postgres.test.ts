// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { NextRequest } from 'next/server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
vi.mock('@/lib/permissions', () => ({
  checkPermissionWithUser: async () => ({ ok: true, user: { user_id: '11111111-1111-4111-8111-111111111111', role: 'admin' } }),
  isCampaignOwnerOrAdmin: () => true, canAccess: () => true,
}))
vi.mock('@/lib/audit', () => ({ audit: mocks.audit }))
vi.mock('@/lib/campaign-distributor', () => ({ createDispatchUnits: vi.fn(), createDispatchUnitsFromProspectList: vi.fn(), processMultiLineInBackground: vi.fn() }))
vi.mock('@/lib/send-processor', () => ({ processInBackground: vi.fn() }))
import { PATCH } from '@/app/api/campaigns/[id]/schedule/route'
import { claimDueCampaigns } from '@/lib/campaign-scheduler'

const id = '22222222-2222-4222-8222-222222222222', owner = '11111111-1111-4111-8111-111111111111'
const oldSchedule = '2020-01-01T20:30:00.000Z', future = '2035-10-03T20:30:00.000Z'
const schema = `reschedule_${randomUUID().replaceAll('-', '')}`
const localUrl = process.env.OPS_TEST_DATABASE_URL

describe.skipIf(!localUrl)('rescheduling against the real PostgreSQL scheduler', () => {
  let db: Client, scheduler: Client
  let beforeUpdate: (() => Promise<void>) | null = null
  const run = (expected = oldSchedule, next = future) => PATCH(new NextRequest(`http://localhost/api/campaigns/${id}/schedule`, {
    method: 'PATCH', body: JSON.stringify({ scheduled_at: next, expected_scheduled_at: expected }),
  }), { params: Promise.resolve({ id }) })

  beforeAll(async () => {
    const url = new URL(localUrl!)
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    db = new Client({ connectionString: url.toString(), ssl: false })
    scheduler = new Client({ connectionString: url.toString(), ssl: false })
    await db.connect(); await scheduler.connect()
    await db.query(`CREATE SCHEMA ${schema}`)
    await db.query(`SET search_path TO ${schema}`); await scheduler.query(`SET search_path TO ${schema}`)
    await db.query(`CREATE TABLE campaigns (
      id uuid PRIMARY KEY, owned_by uuid, status text, scheduled_at timestamptz, started_at timestamptz,
      processor_locked_at timestamptz, processor_lock_token uuid, updated_at timestamptz, updated_by uuid,
      pause_reason text, list_id uuid, prospect_list_id uuid, template_id uuid,
      name text, message text, template_params jsonb, total_sent int DEFAULT 0);
      CREATE TABLE users (id uuid, role text, sectors text[], is_active boolean);
      CREATE TABLE whatsapp_templates (id uuid, name text, language text, waba_id text, status text);
      INSERT INTO users VALUES ('${owner}', 'admin', '{}', true)`)
    mocks.query.mockImplementation(async (sql: string, args: unknown[]) => {
      if (sql.includes('UPDATE campaigns SET scheduled_at') && beforeUpdate) {
        const hook = beforeUpdate; beforeUpdate = null; await hook()
      }
      return (await db.query(sql, args)).rows
    })
    mocks.transaction.mockImplementation(async fn => {
      await scheduler.query('BEGIN')
      try { const result = await fn(scheduler); await scheduler.query('COMMIT'); return result }
      catch (error) { await scheduler.query('ROLLBACK'); throw error }
    })
  })
  beforeEach(async () => {
    beforeUpdate = null; mocks.audit.mockClear()
    vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED', 'true'); vi.stubEnv('CRON_SECRET', 'synthetic')
    await db.query('TRUNCATE campaigns')
    await db.query(`INSERT INTO campaigns (id, owned_by, status, scheduled_at, list_id, name, message, template_params)
      VALUES ($1,$2,'scheduled',$3,$1,'Original','Sin cambios','{"body":["Nombre"]}')`, [id, owner, oldSchedule])
  })
  afterEach(() => vi.unstubAllEnvs())
  afterAll(async () => {
    if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end() }
    if (scheduler) await scheduler.end()
  })

  it('moves a due campaign to the future without changing its content or letting the scheduler claim it', async () => {
    expect((await run()).status).toBe(200)
    const saved = (await db.query('SELECT * FROM campaigns')).rows[0]
    expect(saved).toMatchObject({ status: 'scheduled', name: 'Original', message: 'Sin cambios', template_params: { body: ['Nombre'] }, total_sent: 0, started_at: null, updated_by: owner })
    expect(saved.scheduled_at.toISOString()).toBe(future)
    expect(await claimDueCampaigns()).toEqual({ jobs: [], blocked: 0 })
  })
  it('rejects a stale editor without overwriting the new time', async () => {
    expect((await run()).status).toBe(200)
    expect((await run(oldSchedule, '2035-10-04T20:30:00Z')).status).toBe(409)
    expect((await db.query('SELECT scheduled_at FROM campaigns')).rows[0].scheduled_at.toISOString()).toBe(future)
    expect(mocks.audit).toHaveBeenCalledTimes(1)
  })
  it('loses safely when the scheduler claims after the edit authorization check', async () => {
    beforeUpdate = async () => { expect((await claimDueCampaigns()).jobs).toHaveLength(1) }
    expect((await run()).status).toBe(409)
    const saved = (await db.query('SELECT * FROM campaigns')).rows[0]
    expect(saved.status).toBe('running'); expect(saved.processor_lock_token).toBeTruthy()
    expect(saved.scheduled_at.toISOString()).toBe(oldSchedule)
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it('does not update after ownership changes during the request', async () => {
    beforeUpdate = async () => { await scheduler.query('UPDATE campaigns SET owned_by=$1', [randomUUID()]) }
    expect((await run()).status).toBe(409)
    expect((await db.query('SELECT scheduled_at FROM campaigns')).rows[0].scheduled_at.toISOString()).toBe(oldSchedule)
  })
})
