// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const mocks = vi.hoisted(() => ({ query: vi.fn(), tx: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.tx }))
vi.mock('@/lib/campaign-distributor', () => ({ createDispatchUnits: vi.fn(), createDispatchUnitsFromProspectList: vi.fn(), processMultiLineInBackground: vi.fn() }))
vi.mock('@/lib/send-processor', () => ({ processInBackground: vi.fn() }))
vi.mock('@/lib/cloud-api/meta-risk-refresh', () => ({ refreshCampaignMetaRisk: vi.fn() }))
import { claimDueCampaigns } from '@/lib/campaign-scheduler'
const localUrl = process.env.OPS_TEST_DATABASE_URL || (process.env.RUN_CAMPAIGN_PG_TESTS === '1' ? process.env.TEST_DATABASE_URL || process.env.DATABASE_URL : '')
describe.skipIf(!localUrl)('budget scheduler: real PostgreSQL claims and migration', () => {
  let pool: Pool
  const schema = `budget_scheduler_${process.pid}`
  const owner = randomUUID(), list = randomUUID(), line = randomUUID()
  beforeAll(async () => {
    const url = new URL(localUrl!)
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    pool = new Pool({ connectionString: url.toString(), ssl: false, max: 5, options: `-c search_path=${schema}` })
    await pool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE users(id uuid PRIMARY KEY, role text, sectors text[], is_active boolean);
      CREATE TABLE contact_lists(id uuid PRIMARY KEY, owned_by uuid);
      CREATE TABLE prospect_lists(id uuid PRIMARY KEY, owned_by uuid);
      CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY,line_type text,status text,is_connected boolean,sending_enabled boolean,allowed_types jsonb);
      CREATE TABLE cloud_numbers(whatsapp_line_id uuid,phone_number_id text,waba_id text,status text);
      CREATE TABLE whatsapp_templates(id uuid PRIMARY KEY,name text,language text,waba_id text,status text);
      CREATE TABLE campaigns(id uuid PRIMARY KEY,owned_by uuid,status text,pause_reason text,scheduled_at timestamptz,
        processor_locked_at timestamptz,processor_lock_token uuid,started_at timestamptz,updated_at timestamptz,
        list_id uuid,prospect_list_id uuid,use_multi_line boolean,template_id uuid,message_type text,is_priority_broadcast boolean DEFAULT false);
      CREATE TABLE campaign_recipients(campaign_id uuid,line_id uuid);
      CREATE TABLE campaign_risk_incidents(campaign_id uuid,resolved_at timestamptz);
      CREATE TABLE campaign_risk_signals(scope_type text,scope_id text,signal_active boolean);
      CREATE FUNCTION get_accessible_line_ids(uuid) RETURNS TABLE(id uuid) LANGUAGE sql AS $$ SELECT id FROM whatsapp_lines $$;
      CREATE TABLE automation_message_jobs(id uuid,phone text,agent_code text,created_at timestamptz,provider text,source_id text,status text);`)
    await pool.query(readFileSync('../db/migrations/159_line_protection_controls.sql','utf8'))
    mocks.query.mockImplementation(async (sql, params) => (await pool.query(sql, params)).rows)
    mocks.tx.mockImplementation(async fn => {
      const client = await pool.connect()
      try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value }
      catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    })
  })
  beforeEach(async () => {
    vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED','true')
    await pool.query(`TRUNCATE campaigns,users,contact_lists,prospect_lists,campaign_recipients,campaign_risk_incidents,campaign_risk_signals,cloud_numbers,whatsapp_templates,whatsapp_lines CASCADE`)
    await pool.query("INSERT INTO users VALUES($1,'operator',ARRAY['campaigns','send'],true);",[owner])
    await pool.query('INSERT INTO contact_lists VALUES($1,$2)',[list,owner])
    await pool.query("INSERT INTO whatsapp_lines(id,line_type,status,is_connected,sending_enabled) VALUES($1,'cloud','active',true,true)",[line])
    await pool.query("INSERT INTO cloud_numbers VALUES($1,'phone-1','waba-1','active')",[line])
  })
  afterAll(async () => { vi.unstubAllEnvs(); if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end() } })
  async function campaign(status='paused',reason:string|null='line_budget',future=false) {
    const id = randomUUID()
    await pool.query(`INSERT INTO campaigns(id,owned_by,status,pause_reason,scheduled_at,budget_resume_at,list_id,use_multi_line,message_type)
      VALUES($1,$2,$3,$4,NOW()-interval '1 minute',NOW()+($5*interval '1 minute'),$6,true,'text')`,[id,owner,status,reason,future?60:-1,list])
    return id
  }
  it('only resumes due budget waits or scheduled work, never manual/risk/error pauses', async () => {
    const due = await campaign(), scheduled = await campaign('scheduled',null)
    await campaign('paused','manual');await campaign('paused','risk_detected');await campaign('paused','systemic_error')
    await campaign('paused','line_budget',true);await campaign('cancelled','line_budget');await campaign('completed',null)
    const result = await claimDueCampaigns()
    expect(result.jobs.map(j=>j.campaign.id).sort()).toEqual([due,scheduled].sort())
    expect(result.jobs.find(j=>j.campaign.id===due)?.resumingBudget).toBe(true)
    const saved = (await pool.query('SELECT status,pause_reason,budget_resume_at FROM campaigns WHERE id=$1',[due])).rows[0]
    expect(saved).toEqual({status:'running',pause_reason:null,budget_resume_at:null})
  })
  it('two scheduler workers cannot claim the same budget wait', async () => {
    await campaign()
    const results = await Promise.all([claimDueCampaigns(),claimDueCampaigns()])
    expect(results.flatMap(r=>r.jobs)).toHaveLength(1)
  })
  it('blocks unresolved campaign incidents even when pause_reason says budget', async () => {
    const id = await campaign()
    await pool.query('INSERT INTO campaign_risk_incidents VALUES($1,NULL)',[id])
    expect((await claimDueCampaigns()).jobs).toHaveLength(0)
  })
  it('blocks an active WABA signal before assigning any recipient to a line', async () => {
    await campaign()
    await pool.query("INSERT INTO campaign_risk_signals VALUES('waba','waba-1',true)")
    expect((await claimDueCampaigns()).jobs).toHaveLength(0)
  })
  it('revoked send permission cancels continuation and requires configuration review', async () => {
    const id = await campaign()
    await pool.query("UPDATE users SET sectors=ARRAY['campaigns']")
    expect(await claimDueCampaigns()).toEqual({jobs:[],blocked:1})
    expect((await pool.query('SELECT pause_reason,budget_resume_at FROM campaigns WHERE id=$1',[id])).rows[0])
      .toEqual({pause_reason:'config_missing',budget_resume_at:null})
  })
  it('preserves opt-in defaults and protects all internal control tables with RLS', async () => {
    expect((await pool.query('SELECT respect_daily_recommendation FROM whatsapp_lines WHERE id=$1',[line])).rows[0].respect_daily_recommendation).toBe(false)
    const rls = (await pool.query(`SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace=$1::regnamespace
      AND relname IN ('line_campaign_daily_budgets','line_send_budget_reservations','automation_conversation_safety')`,[schema])).rows
    expect(rls).toHaveLength(3);expect(rls.every(r=>r.relrowsecurity)).toBe(true)
    const grants = (await pool.query(`SELECT table_name,grantee FROM information_schema.role_table_grants
      WHERE table_schema=$1 AND table_name IN ('line_campaign_daily_budgets','line_send_budget_reservations','automation_conversation_safety')
      AND grantee IN ('PUBLIC','anon','authenticated')`,[schema])).rows
    expect(grants).toEqual([])
  })
})
