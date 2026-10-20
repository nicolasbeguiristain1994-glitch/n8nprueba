// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), provider: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query, withTransaction: mocks.transaction }))
vi.mock('@/lib/global-opt-out', () => ({ withGlobalSendGuard: async (_phone: string, fn: (db: unknown) => Promise<unknown>) => mocks.transaction(fn) }))
vi.mock('@/lib/cloud-api/infrastructure/meta-http.gateway', () => ({ MetaHttpGateway: class { post = mocks.provider } }))
import {
  raiseRiskIncident, clearMetaRiskSignal, getCampaignRiskState, getCampaignRiskStates,
  reviewCampaignRisk, assertCampaignRiskClear, assertCloudSendRiskClear, evaluateCampaignRisk,
} from '@/lib/campaign-risk'
import { MessageSenderService } from '@/lib/cloud-api/infrastructure/message-sender.service'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const owner = id(1), adminId = id(2), otherOwner = id(3), inactiveAdmin = id(4)
const a = id(10), b = id(11), c = id(12), templateA = id(20), templateC = id(21), lineA = id(30), lineC = id(31)
const signal = (over: Record<string, unknown> = {}) => ({ scopeType: 'campaign' as const, scopeId: a,
  source: 'panel' as const, signal: 'panel_opt_out_rate', title: 'Bajas elevadas', detail: 'Datos sintéticos de protección.', ...over })
const review = async (campaignId = a, userId = owner, incidentIds?: string[]) => reviewCampaignRisk({
  campaignId, userId, note: 'Revisé audiencia y contenido de prueba.',
  incidentIds: incidentIds ?? (await getCampaignRiskState(campaignId)).incidents.map(row => row.id),
})

describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS !== '1')('campaign risk holds on isolated PostgreSQL17, no provider calls', () => {
  let db: Pool, admin: Pool
  const schema = `campaign_risk_${randomUUID().replace(/-/g, '')}`
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!)
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.search) throw Error('LOCAL_ONLY')
    admin = new Pool({ connectionString: url.toString(), ssl: false })
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Pool({ connectionString: url.toString(), ssl: false, max: 8, application_name: schema, options: `-c search_path=${schema},public` })
    await db.query(`
      CREATE TABLE users(id uuid PRIMARY KEY,role text,is_active boolean DEFAULT true,sectors jsonb DEFAULT '[]');
      CREATE TABLE campaigns(id uuid PRIMARY KEY,name text,owned_by uuid REFERENCES users(id),template_id uuid,message_type text DEFAULT 'template',use_multi_line boolean DEFAULT true,
        status text DEFAULT 'running',pause_reason text,updated_at timestamptz DEFAULT now());
      CREATE TABLE whatsapp_templates(id uuid PRIMARY KEY,name text,waba_id text);
      CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY,line_type text DEFAULT 'cloud',status text DEFAULT 'active',is_connected boolean DEFAULT true,sending_enabled boolean DEFAULT true,allowed_types jsonb);
      CREATE FUNCTION get_accessible_line_ids(uuid) RETURNS SETOF uuid LANGUAGE sql AS 'SELECT id FROM whatsapp_lines';
      CREATE TABLE cloud_numbers(id uuid DEFAULT gen_random_uuid(),whatsapp_line_id uuid,phone_number_id text,waba_id text,status text DEFAULT 'active');
      CREATE TABLE campaign_recipients(id uuid DEFAULT gen_random_uuid(),campaign_id uuid REFERENCES campaigns(id),line_id uuid);
      CREATE TABLE whatsapp_messages(id uuid DEFAULT gen_random_uuid(),campaign_id uuid,phone_number text,direction text,
        status text,error_detail text,evolution_message_id text,created_at timestamptz DEFAULT now());
      CREATE TABLE cloud_conversations(id uuid PRIMARY KEY,contact_phone text);
      CREATE TABLE cloud_messages(id uuid DEFAULT gen_random_uuid(),conversation_id uuid,campaign_id uuid,direction text,
        status text,error_code int,wamid text,created_at timestamptz DEFAULT now());
      CREATE TABLE cloud_consent_log(id uuid DEFAULT gen_random_uuid(),contact_phone text,event text,metadata jsonb,created_at timestamptz DEFAULT now());
    `)
    await db.query(readFileSync(new URL('../../../db/migrations/048_notifications.sql', import.meta.url), 'utf8'))
    const migration = readFileSync(new URL('../../../db/migrations/157_campaign_risk_guard.sql', import.meta.url), 'utf8')
    await db.query(migration); await db.query(migration)
    mocks.query.mockImplementation(async (sql, params) => (await db.query(sql, params)).rows)
    mocks.transaction.mockImplementation(async fn => {
      const client = await db.connect()
      try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result }
      catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    })
  })
  beforeEach(async () => {
    mocks.provider.mockReset()
    await db.query(`TRUNCATE campaign_risk_signals,campaign_risk_incidents,notifications,notification_preferences,
      campaign_recipients,whatsapp_templates,whatsapp_lines,cloud_numbers,whatsapp_messages,cloud_messages,cloud_conversations,cloud_consent_log,campaigns,users CASCADE`)
    await db.query(`INSERT INTO users(id,role,is_active,sectors) VALUES
      ($1,'operator',true,'["campaigns","send"]'),($2,'admin',true,'[]'),($3,'operator',true,'["campaigns","send"]'),($4,'admin',false,'[]')`,
    [owner,adminId,otherOwner,inactiveAdmin])
    await db.query(`INSERT INTO whatsapp_templates(id,name,waba_id) VALUES($1,'same_name','waba-a'),($2,'same_name','waba-c')`, [templateA,templateC])
    await db.query(`INSERT INTO campaigns(id,name,owned_by,template_id) VALUES
      ($1,'Campaña A',$4,$6),($2,'Campaña B',$5,$6),($3,'Campaña C',$4,$7)`, [a,b,c,owner,otherOwner,templateA,templateC])
    await db.query(`INSERT INTO cloud_numbers(whatsapp_line_id,phone_number_id,waba_id) VALUES($1,'10001','waba-a'),($2,'10002','waba-c')`, [lineA,lineC])
    await db.query('INSERT INTO whatsapp_lines(id) VALUES($1),($2)',[lineA,lineC])
    await db.query(`INSERT INTO campaign_recipients(campaign_id,line_id) VALUES($1,$4),($2,$4),($3,$5)`, [a,b,c,lineA,lineC])
  })
  afterAll(async () => {
    if (db) await db.end()
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end() }
  })
  const campaign = async (campaignId = a) => (await db.query('SELECT status,pause_reason FROM campaigns WHERE id=$1',[campaignId])).rows[0]
  const count = async (table: string) => Number((await db.query(`SELECT COUNT(*) FROM ${table}`)).rows[0].count)
  const seedDelivered = async (n: number, prefix = '549110000', age = '1 hour') => {
    await db.query(`INSERT INTO whatsapp_messages(campaign_id,phone_number,direction,status,evolution_message_id,created_at)
      SELECT $1,$3||lpad(g::text,4,'0'),'outbound','delivered','delivered-'||$3||g,now()-$4::interval FROM generate_series(1,$2::int) g`,[a,n,prefix,age])
  }
  const seedBajas = async (n: number, prefix = '549110000', age = '30 minutes', campaignId = a) => {
    await db.query(`INSERT INTO cloud_consent_log(contact_phone,event,metadata,created_at)
      SELECT $2||lpad(g::text,4,'0'),'opt_out',jsonb_build_object('campaign_id',$3::text),now()-$4::interval FROM generate_series(1,$1::int) g`,[n,prefix,campaignId,age])
  }

  it('deduplicates concurrent signals/alerts and persists a pause despite notification preferences', async () => {
    await db.query('INSERT INTO notification_preferences(user_id,notify_alerta_operativa) VALUES($1,false)',[owner])
    await Promise.all(Array.from({length: 6}, () => raiseRiskIncident(signal())))
    expect(await campaign()).toEqual({status:'paused',pause_reason:'risk_detected'})
    expect(await count('campaign_risk_signals')).toBe(1); expect(await count('campaign_risk_incidents')).toBe(1)
    expect((await db.query('SELECT user_id,related_type,related_id FROM notifications ORDER BY user_id')).rows).toEqual([
      {user_id:owner,related_type:'campaign',related_id:a},{user_id:adminId,related_type:'campaign',related_id:a},
    ])
    expect(await getCampaignRiskState(a)).toMatchObject({blocked:true,incidents:[{signal:'panel_opt_out_rate',signalActive:true}]})
  })
  it('does not duplicate an administrator who also owns the campaign', async () => {
    await db.query('UPDATE campaigns SET owned_by=$1 WHERE id=$2',[adminId,a])
    await raiseRiskIncident(signal())
    expect(await count('notifications')).toBe(1)
  })
  it('keeps risk tables behind RLS without PUBLIC table grants', async () => {
    const {rows} = await db.query(`SELECT c.relname,c.relrowsecurity,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
        WHERE acl.grantee=0) AS public_grants FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname IN ('campaign_risk_signals','campaign_risk_incidents') ORDER BY c.relname`,[schema])
    expect(rows).toEqual([
      {relname:'campaign_risk_incidents',relrowsecurity:true,public_grants:false},
      {relname:'campaign_risk_signals',relrowsecurity:true,public_grants:false},
    ])
  })
  it.each(['waba','phone','template'] as const)('isolates %s scope and equal template names in another WABA', async scopeType => {
    const scopeId = scopeType==='waba'?'waba-a':scopeType==='phone'?'10001':'waba-a:same_name'
    await raiseRiskIncident({...signal(),scopeType,scopeId,source:'meta'})
    const states = await getCampaignRiskStates([a,b,c])
    expect(states[a].blocked).toBe(true); expect(states[b].blocked).toBe(true); expect(states[c].blocked).toBe(false)
    expect(await campaign(c)).toEqual({status:'running',pause_reason:null})
    expect(await count('notifications')).toBe(4)
    await expect(assertCloudSendRiskClear({phoneNumberId:'10002',templateName:'same_name',campaignId:c})).resolves.toBeUndefined()
    await expect(assertCloudSendRiskClear({phoneNumberId:'10001',templateName:'same_name',campaignId:a})).rejects.toThrow(/riesgo/)
  })
  it('blocks a newly created campaign that matches an already active account signal', async () => {
    await raiseRiskIncident({...signal(),scopeType:'waba',scopeId:'waba-a',source:'meta'})
    await db.query('INSERT INTO campaigns(id,name,owned_by,template_id,status) VALUES($1,$2,$3,$4,$5)',[id(99),'Nueva',owner,templateA,'draft'])
    expect((await getCampaignRiskState(id(99))).blocked).toBe(true)
    await expect(assertCampaignRiskClear(id(99))).rejects.toThrow(/riesgo/)
  })
  it('holds a candidate phone before routing without crossing the template WABA', async () => {
    await db.query('DELETE FROM campaign_recipients')
    await raiseRiskIncident({...signal(),scopeType:'phone',scopeId:'10001',source:'meta'})
    const states = await getCampaignRiskStates([a,b,c])
    expect(states[a].blocked).toBe(true); expect(states[b].blocked).toBe(true); expect(states[c].blocked).toBe(false)
  })
  it('excludes a phone from the unrouted candidate pool when campaigns are not allowed', async () => {
    await db.query('DELETE FROM campaign_recipients')
    await db.query(`UPDATE whatsapp_lines SET allowed_types='["reply"]'::jsonb WHERE id=$1`,[lineA])
    await raiseRiskIncident({...signal(),scopeType:'phone',scopeId:'10001',source:'meta'})
    expect((await getCampaignRiskState(a)).blocked).toBe(false)
  })
  it('does not create new global incidents on historical completed/cancelled campaigns when listing', async () => {
    await db.query("UPDATE campaigns SET status=CASE WHEN id=$1 THEN 'completed' ELSE 'cancelled' END WHERE id=ANY($2::uuid[])",[a,[a,b]])
    await raiseRiskIncident({...signal(),scopeType:'waba',scopeId:'waba-a',source:'meta'})
    const states = await getCampaignRiskStates([a,b])
    expect(states[a].blocked).toBe(false); expect(states[b].blocked).toBe(false)
    expect(await count('notifications')).toBe(0)
    expect(await campaign(a)).toEqual({status:'completed',pause_reason:null})
    await raiseRiskIncident(signal())
    expect((await getCampaignRiskState(a)).blocked).toBe(true)
  })
  it('rolls back signal, incident and pause if the durable alert cannot be written', async () => {
    await db.query('ALTER TABLE notifications ADD CONSTRAINT reject_risk_test CHECK (false)')
    try {
      await expect(raiseRiskIncident(signal())).rejects.toThrow()
      expect(await count('campaign_risk_signals')).toBe(0); expect(await count('campaign_risk_incidents')).toBe(0)
      expect(await campaign()).toEqual({status:'running',pause_reason:null})
    } finally { await db.query('ALTER TABLE notifications DROP CONSTRAINT reject_risk_test') }
  })
  it('requires official recovery then records review without resuming or losing evidence', async () => {
    await raiseRiskIncident({...signal(),source:'meta',observedAt:'2026-10-19T12:00:00Z'})
    await expect(review()).rejects.toThrow(/Meta/)
    await clearMetaRiskSignal({scopeType:'campaign',scopeId:a,signals:['panel_opt_out_rate'],observedAt:'2026-10-19T12:01:00Z'})
    await raiseRiskIncident({...signal(),source:'meta',observedAt:'2026-10-19T12:00:30Z'})
    expect((await getCampaignRiskState(a)).incidents[0].signalActive).toBe(false)
    await review()
    expect(await campaign()).toEqual({status:'paused',pause_reason:'manual'})
    expect((await getCampaignRiskState(a)).blocked).toBe(false)
    expect((await db.query('SELECT reviewed_by,review_note,resolved_at FROM campaign_risk_incidents')).rows[0]).toMatchObject({reviewed_by:owner,review_note:'Revisé audiencia y contenido de prueba.',resolved_at:expect.any(Date)})
    expect(await count('notifications')).toBe(2)
  })
  it('keeps a recovery tombstone when an older warning arrives out of order', async () => {
    await clearMetaRiskSignal({scopeType:'waba',scopeId:'waba-a',signals:['official'],observedAt:'2026-10-19T12:02:00Z'})
    await raiseRiskIncident({...signal(),scopeType:'waba',scopeId:'waba-a',source:'meta',signal:'official',observedAt:'2026-10-19T12:01:00Z'})
    expect((await getCampaignRiskState(a)).blocked).toBe(false); expect(await count('notifications')).toBe(0)
  })
  it('rejects a stale review snapshot after another signal appears', async () => {
    await raiseRiskIncident(signal())
    const previous = (await getCampaignRiskState(a)).incidents.map(row=>row.id)
    await raiseRiskIncident({...signal(),signal:'another_risk'})
    await expect(review(a,owner,previous)).rejects.toThrow(/cambiaron/)
    expect((await getCampaignRiskState(a)).incidents).toHaveLength(2)
    expect(await campaign()).toEqual({status:'paused',pause_reason:'risk_detected'})
  })
  it.each(['transfer','deactivate','role','sectors'])('rechecks review authorization after %s', async change => {
    await raiseRiskIncident(signal())
    if(change==='transfer') await db.query('UPDATE campaigns SET owned_by=$1 WHERE id=$2',[otherOwner,a])
    else if(change==='deactivate') await db.query('UPDATE users SET is_active=false WHERE id=$1',[owner])
    else if(change==='role') await db.query("UPDATE users SET role='viewer' WHERE id=$1",[owner])
    else await db.query("UPDATE users SET sectors='[\"campaigns\"]'::jsonb WHERE id=$1",[owner])
    await expect(review()).rejects.toThrow(/acceso/)
    expect((await getCampaignRiskState(a)).blocked).toBe(true)
  })
  it('serializes two reviewers so only the first can resolve the same snapshot', async () => {
    await raiseRiskIncident(signal())
    const ids=(await getCampaignRiskState(a)).incidents.map(row=>row.id)
    const results=await Promise.allSettled([review(a,owner,ids),review(a,adminId,ids)])
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    expect(await campaign()).toEqual({status:'paused',pause_reason:'manual'})
  })
  it('lets an in-flight acceptance finish but fences the next send behind a concurrent pause', async () => {
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    mocks.provider.mockImplementation(async () => { entered(); await held; return {messages:[{id:'wamid.synthetic'}]} })
    const sender = new MessageSenderService('synthetic-test-token','10001')
    const request = {phoneNumberId:'10001',to:'+5491100000001',type:'text' as const,text:{body:'Synthetic test only'},campaignId:a}
    const first = sender.send(request)
    await started
    try {
      const pause = raiseRiskIncident(signal())
      await vi.waitFor(async () => {
        const waiting = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[schema])
        expect(waiting.rows.length).toBeGreaterThan(0)
      }, { timeout: 2000, interval: 10 })
      const second = sender.send({...request,to:'+5491100000002'}).then(value=>({value,error:null}),error=>({value:null,error}))
      release()
      expect(await first).toEqual({wamid:'wamid.synthetic'})
      await pause
      expect((await second).error).toMatchObject({code:'CAMPAIGN_RISK_BLOCKED'})
      expect(mocks.provider).toHaveBeenCalledTimes(1)
      expect(await campaign()).toEqual({status:'paused',pause_reason:'risk_detected'})
    } finally { release() }
  })
  it('counts unique deliveries/attributed bajas and ignores duplicate provider records', async () => {
    await seedDelivered(50); await seedBajas(5); await seedBajas(1,'549119999'); await seedBajas(5,'549110000','30 minutes',c)
    await db.query(`INSERT INTO cloud_conversations SELECT gen_random_uuid(),phone_number FROM whatsapp_messages;
      INSERT INTO cloud_messages(conversation_id,campaign_id,direction,status,wamid,created_at)
      SELECT cv.id,w.campaign_id,w.direction,w.status,w.evolution_message_id,w.created_at
      FROM whatsapp_messages w JOIN cloud_conversations cv ON cv.contact_phone=w.phone_number`)
    await evaluateCampaignRisk(a)
    expect((await getCampaignRiskState(a)).incidents[0]).toMatchObject({signal:'panel_opt_out_rate',metrics:{delivered:50,optouts:5,attempts:50}})
  })
  it('requires the minimum sample and restarts the observation window after review', async () => {
    await seedDelivered(49); await seedBajas(5); await evaluateCampaignRisk(a)
    expect((await getCampaignRiskState(a)).blocked).toBe(false)
    await seedDelivered(1,'549118888'); await evaluateCampaignRisk(a); await review()
    await evaluateCampaignRisk(a)
    expect((await getCampaignRiskState(a)).blocked).toBe(false)
    await seedDelivered(50,'549117777','0 seconds'); await seedBajas(5,'549117777','0 seconds')
    await evaluateCampaignRisk(a)
    expect((await getCampaignRiskState(a)).incidents[0]).toMatchObject({metrics:{delivered:50,optouts:5}})
  })
  it('excludes observations older than24h and requires the configured baja rate', async () => {
    await seedDelivered(200); await seedBajas(5); await evaluateCampaignRisk(a)
    expect((await getCampaignRiskState(a)).blocked).toBe(false)
    await seedBajas(10,'549110000','25 hours'); await evaluateCampaignRisk(a)
    expect((await getCampaignRiskState(a)).blocked).toBe(false)
    await seedBajas(10); await evaluateCampaignRisk(a)
    expect((await getCampaignRiskState(a)).blocked).toBe(true)
  })
  it('pauses for ten131049 of50 attempts, not ordinary undeliverable/experiment codes', async () => {
    await db.query(`INSERT INTO whatsapp_messages(campaign_id,phone_number,direction,status,evolution_message_id,error_detail)
      SELECT $1,'54911'||g,'outbound','failed','failure-'||g,
        CASE WHEN g<=25 THEN '[meta:131026] Undeliverable' ELSE '[meta:130472] Experiment' END FROM generate_series(1,50) g`,[a])
    await evaluateCampaignRisk(a); expect((await getCampaignRiskState(a)).blocked).toBe(false)
    await db.query("UPDATE whatsapp_messages SET error_detail='[meta:131049] Healthy ecosystem' WHERE evolution_message_id IN(SELECT 'failure-'||g FROM generate_series(1,9) g)")
    await evaluateCampaignRisk(a); expect((await getCampaignRiskState(a)).blocked).toBe(false)
    await db.query("UPDATE whatsapp_messages SET error_detail='[meta:131049] Healthy ecosystem' WHERE evolution_message_id='failure-10'")
    await evaluateCampaignRisk(a)
    expect((await getCampaignRiskState(a)).incidents[0]).toMatchObject({signal:'panel_ecosystem_rate',metrics:{attempts:50,ecosystem:10}})
  })
})
