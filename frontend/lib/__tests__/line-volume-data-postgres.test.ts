// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
const mocks = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/lib/db', () => ({ query: mocks.query }))
import { getLineVolumeInputs, LINE_VOLUME_HISTORY_SQL } from '@/lib/line-volume-data'
import type { LineVolumeInput } from '@/lib/line-volume-policy'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const a=id(1),b=id(2),evo=id(3),hidden=id(4),campaign=id(10),now=new Date('2026-10-20T15:00:00Z')
const at='2026-10-18T15:00:00Z'
const day = (line: LineVolumeInput,date='2026-10-18') => line.recentDays.find(d => d.date===date)!

describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS!=='1')('line volume evidence on local PostgreSQL', () => {
  let db: Pool,admin: Pool
  const schema=`line_volume_${randomUUID().replace(/-/g,'')}`
  beforeAll(async () => {
    const url=new URL(process.env.DATABASE_URL!)
    if(!['localhost','127.0.0.1'].includes(url.hostname)||url.search) throw Error('LOCAL_ONLY')
    admin=new Pool({ connectionString: url.toString(),ssl: false })
    await admin.query(`CREATE SCHEMA ${schema}`)
    db=new Pool({ connectionString: url.toString(),ssl: false,options: `-c search_path=${schema},public` })
    await db.query(`CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY,line_type text DEFAULT 'cloud',status text DEFAULT 'active',
      is_connected bool DEFAULT true,sending_enabled bool DEFAULT true,allowed_types jsonb DEFAULT '["campaign"]',
      msg_per_day int DEFAULT 500,msg_per_hour int DEFAULT 50,msgs_sent_today int DEFAULT 10,msgs_sent_hour int DEFAULT 3,
      day_reset_at timestamptz,hour_reset_at timestamptz,evolution_instance text);
      CREATE TABLE cloud_numbers(whatsapp_line_id uuid,phone_number_id text,waba_id text,status text DEFAULT 'active',
        quality_rating text DEFAULT 'GREEN',risk_checked_at timestamptz);
      CREATE TABLE campaign_recipients(id uuid PRIMARY KEY,campaign_id uuid,line_id uuid,attempts int DEFAULT 1);
      CREATE TABLE campaigns(id uuid PRIMARY KEY,owned_by uuid,template_id uuid,message_type text DEFAULT 'template',
        use_multi_line bool DEFAULT true,status text DEFAULT 'running');
      CREATE TABLE whatsapp_templates(id uuid PRIMARY KEY,waba_id text);
      CREATE TABLE line_access(owner_id uuid,line_id uuid);
      CREATE FUNCTION get_accessible_line_ids(uuid) RETURNS SETOF uuid LANGUAGE sql AS
        'SELECT line_id FROM line_access WHERE owner_id=$1';
      CREATE TABLE whatsapp_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),campaign_id uuid,campaign_recipient_id uuid,
        phone_number text DEFAULT '54911111111',
        evolution_message_id text,whatsapp_message_id text,direction text DEFAULT 'outbound',status text DEFAULT 'sent',metadata jsonb DEFAULT '{}',error_detail text,
        error_code text,sent_at timestamptz DEFAULT now(),failed_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE cloud_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),phone_number_id text,campaign_id uuid,wamid text,
        conversation_id uuid,queued_at timestamptz,
        direction text DEFAULT 'outbound',status text DEFAULT 'sent',content jsonb DEFAULT '{}',error_title text,error_details text,error_code int,
        is_historical bool DEFAULT false,sent_at timestamptz,failed_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE cloud_conversations(id uuid PRIMARY KEY,contact_phone text);
      CREATE TABLE line_usage_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),line_id uuid,campaign_id uuid,recipient_id uuid,
        status text,error_code text,error_message text,created_at timestamptz DEFAULT now());
      CREATE TABLE cloud_consent_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),phone_number_id text,contact_phone text,
        event text DEFAULT 'opt_out',created_at timestamptz DEFAULT now());
      CREATE TABLE campaign_risk_signals(scope_type text,scope_id text,signal text,signal_active bool DEFAULT true);
      CREATE TABLE campaign_risk_incidents(campaign_id uuid,scope_type text,scope_id text,signal text,
        detected_at timestamptz DEFAULT now(),last_observed_at timestamptz,resolved_at timestamptz);`)
    mocks.query.mockImplementation(async (sql,params)=>(await db.query(sql,params)).rows)
  })
  beforeEach(async () => {
    await db.query('TRUNCATE whatsapp_lines,cloud_numbers,campaign_recipients,campaigns,whatsapp_templates,line_access,whatsapp_messages,cloud_messages,cloud_conversations,line_usage_log,cloud_consent_log,campaign_risk_signals,campaign_risk_incidents')
    await db.query("INSERT INTO whatsapp_lines(id,line_type,evolution_instance) VALUES($1,'cloud','cloud-a'),($2,'cloud','cloud-b'),($3,'evolution','synthetic-evo'),($4,'cloud','hidden')",[a,b,evo,hidden])
    await db.query("INSERT INTO cloud_numbers(whatsapp_line_id,phone_number_id,waba_id,risk_checked_at) VALUES($1,'101','same-waba',$4),($2,'102','same-waba',$4),($3,'104','private-waba',$4)",[a,b,hidden,now])
    mocks.query.mockClear()
  })
  afterAll(async () => { if(db) await db.end(); if(admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end() } })
  async function legacy(over: { line?: string;at?: string;status?: string;wamid?: string|null;error?: string;attempts?: number;recipient?: string;meta?: object }={}) {
    const recipient=over.recipient??randomUUID(),time=over.at??at
    await db.query('INSERT INTO campaign_recipients(id,campaign_id,line_id,attempts) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[recipient,campaign,over.line??a,over.attempts??1])
    await db.query(`INSERT INTO whatsapp_messages(campaign_id,campaign_recipient_id,evolution_message_id,status,error_detail,
      sent_at,failed_at,created_at,updated_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$6,$6,$6,$7)`,
    [campaign,recipient,over.wamid===undefined?randomUUID():over.wamid,over.status??'delivered',over.error??null,time,over.meta??{}])
    return recipient
  }
  async function cloud(over: { phone?: string;to?: string;at?: string;status?: string;wamid?: string|null;historical?: boolean;direction?: string;campaign?: string|null;source?: string;code?: number }={}) {
    const conv=randomUUID()
    await db.query('INSERT INTO cloud_conversations(id,contact_phone) VALUES($1,$2)',[conv,over.to??'+54911111111'])
    await db.query(`INSERT INTO cloud_messages(phone_number_id,campaign_id,wamid,status,sent_at,failed_at,created_at,is_historical,direction,content,error_code,conversation_id,queued_at)
      VALUES($1,$2,$3,$4,CASE WHEN $4='queued' THEN NULL ELSE $5::timestamptz END,$5,$5,$6,$7,$8,$9,$10,$5)`,[over.phone??'101',over.campaign===undefined?campaign:over.campaign,
      over.wamid===undefined?randomUUID():over.wamid,over.status??'delivered',over.at??at,over.historical??false,over.direction??'outbound',
      over.source?{ source: over.source }:{},over.code??null,conv])
  }
  it('returns an empty scope before querying and cannot expose a hidden line',async () => {
    expect(await getLineVolumeInputs([],now)).toEqual([]);expect(mocks.query).not.toHaveBeenCalled()
    await cloud({ phone: '104' })
    expect((await getLineVolumeInputs([a],now)).map(l=>l.id)).toEqual([a])
    expect((await getLineVolumeInputs(null,now)).map(l=>l.id)).toEqual([a,b,evo,hidden])
  })
  it('projects expired quotas without a database mutation and returns exactly28 local days',async () => {
    await db.query('UPDATE whatsapp_lines SET day_reset_at=$1,hour_reset_at=$1 WHERE id=$2',[at,a])
    const client=await db.connect()
    await client.query('BEGIN READ ONLY')
    mocks.query.mockImplementation(async(sql,params)=>(await client.query(sql,params)).rows)
    try {
      const [line]=await getLineVolumeInputs([a],now)
      expect(line).toMatchObject({ dailyUsed: 0,hourlyUsed: 0,dailyLimit: 500,quality: 'GREEN',evidenceIncomplete: false })
      expect(line.recentDays).toHaveLength(28)
      expect(line.recentDays[0].date).toBe('2026-09-23');expect(line.recentDays.at(-1)?.date).toBe('2026-10-20')
    } finally {
      await client.query('ROLLBACK');client.release()
      mocks.query.mockImplementation(async(sql,params)=>(await db.query(sql,params)).rows)
    }
    expect((await db.query('SELECT msgs_sent_today,msgs_sent_hour FROM whatsapp_lines WHERE id=$1',[a])).rows[0]).toEqual({ msgs_sent_today: 10,msgs_sent_hour: 3 })
  })
  it('deduplicates the same accepted message and honors a later delivery receipt',async () => {
    await legacy({ wamid: 'same-wamid',status: 'sent' });await cloud({ wamid: 'same-wamid' })
    const [line]=await getLineVolumeInputs([a],now)
    expect(day(line)).toMatchObject({ attempted: 1,accepted: 1,delivered: 1,failed: 0,unknown: 0 })
    expect(line.evidenceIncomplete).toBe(false)
  })
  it('counts a send on the Argentina day, regardless of a later delivery day',async () => {
    await legacy({ at: '2026-10-19T02:59:59Z' });await cloud({ at: '2026-10-19T03:00:00Z' })
    const [line]=await getLineVolumeInputs([a],now)
    expect(day(line,'2026-10-18').delivered).toBe(1);expect(day(line,'2026-10-19').delivered).toBe(1)
  })
  it('excludes service, operational, echo, inbound and imported messages from growth',async () => {
    await cloud({ campaign: null });await cloud({ source: 'campaign_risk_alert' });await cloud({ source: 'opt_out_confirmation' })
    await cloud({ direction: 'echo' });await cloud({ direction: 'inbound' });await cloud({ historical: true })
    expect(day((await getLineVolumeInputs([a],now))[0]).attempted).toBe(0)
  })
  it('does not count pre-provider guard failures as attempted sends',async () => {
    for(const error of ['risk-guard-no-send','line-unavailable-before-send','pre-send-persistence-error','[global-opt-out] baja'])
      await legacy({ status: 'failed',wamid: null,error })
    const [line]=await getLineVolumeInputs([a],now)
    expect(day(line)).toMatchObject({ attempted: 0,failed: 0 });expect(line.evidenceIncomplete).toBe(false)
  })
  it('retains ambiguous outcomes and prevents them from authorizing growth',async () => {
    await legacy({ status: 'queued',wamid: null });await legacy({ status: 'failed',wamid: null,error: '[provider-outcome-unknown-no-resend] timeout' })
    const [line]=await getLineVolumeInputs([a],now)
    expect(day(line)).toMatchObject({ attempted: 2,accepted: 0,failed: 0,unknown: 2 });expect(line.evidenceIncomplete).toBe(true)
  })
  it('preserves a rejected retry after the recipient succeeds, without double-counting a final failure',async () => {
    const recipient=await legacy({ attempts: 2 })
    await db.query("INSERT INTO line_usage_log(line_id,campaign_id,recipient_id,status,error_message,created_at) VALUES($1,$2,$3,'failed','[meta:131049] rejected',$4)",[a,campaign,recipient,at])
    let line=(await getLineVolumeInputs([a],now))[0]
    expect(day(line)).toMatchObject({ attempted: 2,accepted: 1,delivered: 1,failed: 1,ecosystemRejected: 1 });expect(line.evidenceIncomplete).toBe(true)
    await db.query('TRUNCATE whatsapp_messages,line_usage_log,campaign_recipients')
    const failed=await legacy({ status: 'failed',wamid: null,error: '[meta:131049] rejected' })
    await db.query("INSERT INTO line_usage_log(line_id,campaign_id,recipient_id,status,error_message,created_at) VALUES($1,$2,$3,'failed','[meta:131049] rejected',$4)",[a,campaign,failed,at])
    line=(await getLineVolumeInputs([a],now))[0]
    expect(day(line)).toMatchObject({ attempted: 1,accepted: 0,failed: 1,ecosystemRejected: 1 });expect(line.evidenceIncomplete).toBe(false)
  })
  it('attributes a cleared retry to its log conservatively without treating it as healthy history',async () => {
    const recipient=await legacy({ status: 'failed',wamid: null,error: '[meta:131049] rejected',attempts: 2 })
    await db.query('UPDATE campaign_recipients SET line_id=NULL WHERE id=$1',[recipient])
    await db.query("INSERT INTO line_usage_log(line_id,campaign_id,recipient_id,status,error_message,created_at) VALUES($1,$2,$3,'failed','[meta:131049] rejected',$4)",[a,campaign,recipient,at])
    const [line]=await getLineVolumeInputs([a],now)
    expect(day(line)).toMatchObject({ attempted: 1,failed: 1,ecosystemRejected: 1 });expect(line.evidenceIncomplete).toBe(true)
  })
  it('counts unique opt-outs for the actual Cloud or Evolution source, not another line',async () => {
    await db.query(`INSERT INTO cloud_consent_log(phone_number_id,contact_phone,created_at) VALUES
      ('101','+54911111111',$1),('101','54911111111',$1),('102','54922222222',$1),('evolution:synthetic-evo','54933333333',$1)`,[at])
    const rows=await getLineVolumeInputs([a,evo],now)
    expect(day(rows.find(l=>l.id===a)!).optOuts).toBe(1);expect(day(rows.find(l=>l.id===evo)!).optOuts).toBe(1)
  })
  it('applies shared WABA risk and pending campaign review without returning private details',async () => {
    await db.query("INSERT INTO campaign_risk_signals(scope_type,scope_id,signal) VALUES('waba','same-waba','meta_account_restriction')")
    let rows=await getLineVolumeInputs([a,b,evo],now)
    expect(rows.filter(l=>l.activeRiskReasons.length).map(l=>l.id)).toEqual([a,b])
    await db.query('TRUNCATE campaign_risk_signals')
    await legacy()
    await db.query("INSERT INTO campaign_risk_incidents(campaign_id,scope_type,scope_id,signal,detected_at,last_observed_at) VALUES($1::uuid,'campaign',$1::uuid::text,'panel_opt_out_rate',$2,$2)",[campaign,at])
    rows=await getLineVolumeInputs([a,b],now)
    expect(rows[0].activeRiskReasons).toHaveLength(1);expect(rows[1].activeRiskReasons).toEqual([])
    expect(JSON.stringify(rows)).not.toContain(campaign)
    await db.query('UPDATE campaign_risk_incidents SET resolved_at=$1',[now])
    const [line]=await getLineVolumeInputs([a],now)
    expect(line.activeRiskReasons).toEqual([]);expect(line.lastRiskAt).toBe(now.toISOString())
  })
  it('uses the weakest connection and oldest complete check if a line has multiple Cloud mappings',async () => {
    await db.query("INSERT INTO cloud_numbers(whatsapp_line_id,phone_number_id,waba_id,status,quality_rating) VALUES($1,'105','other','suspended','RED')",[a])
    expect((await getLineVolumeInputs([a],now))[0]).toMatchObject({ cloudStatus: 'inactive',quality: 'RED',lastMetaCheckAt: null,evidenceIncomplete: true })
  })
  it('does not double-count delivered failures across the two histories',async () => {
    await legacy({ wamid: 'late-failed',status: 'failed',error: '[meta:131049] rejected' });await cloud({ wamid: 'late-failed',status: 'delivered' })
    expect(day((await getLineVolumeInputs([a],now))[0])).toMatchObject({ attempted: 1,accepted: 1,delivered: 1,failed: 0,ecosystemRejected: 0 })
  })
  it('deduplicates a legacy whatsapp_message_id alias against Cloud history',async () => {
    const recipient=await legacy({ wamid: null })
    await db.query('UPDATE whatsapp_messages SET whatsapp_message_id=$1 WHERE campaign_recipient_id=$2',['alias-wamid',recipient])
    await cloud({ wamid: 'alias-wamid' })
    const [line]=await getLineVolumeInputs([a],now)
    expect(day(line)).toMatchObject({ attempted: 1,delivered: 1 });expect(line.evidenceIncomplete).toBe(false)
  })
  it('blocks a candidate before recipients are assigned, respecting its owner and template WABA',async () => {
    await db.query('INSERT INTO whatsapp_templates(id,waba_id) VALUES($1,$2)',[id(20),'same-waba'])
    await db.query("INSERT INTO campaigns(id,owned_by,template_id,status) VALUES($1,$2,$3,'paused')",[campaign,id(30),id(20)])
    await db.query('INSERT INTO line_access(owner_id,line_id) VALUES($1,$2)',[id(30),a])
    await db.query("INSERT INTO campaign_risk_incidents(campaign_id,scope_type,scope_id,signal,detected_at) VALUES($1::uuid,'campaign',$1::uuid::text,'meta_check_unavailable',$2)",[campaign,at])
    let rows=await getLineVolumeInputs([a,b,hidden],now)
    expect(rows.filter(l=>l.activeRiskReasons.length).map(l=>l.id)).toEqual([a])
    await db.query('UPDATE campaigns SET owned_by=NULL')
    rows=await getLineVolumeInputs([a,b,hidden],now)
    expect(rows.filter(l=>l.activeRiskReasons.length).map(l=>l.id)).toEqual([a,b])
  })
  it('can execute the aggregation plan within one bounded query for all visible lines',async () => {
    const result=await db.query('EXPLAIN (ANALYZE,FORMAT JSON) '+LINE_VOLUME_HISTORY_SQL,[[a,b,evo],now.toISOString()])
    expect(result.rows[0]['QUERY PLAN'][0]['Execution Time']).toBeLessThan(1000)
  })
  async function rejectedAttempt(attempts=1) {
    const recipient=await legacy({ status: 'failed',wamid: null,error: '[meta:131049] rejected',at: '2026-10-18T15:00:10Z',attempts })
    await db.query('UPDATE whatsapp_messages SET created_at=$1 WHERE campaign_recipient_id=$2',[at,recipient])
    await db.query("INSERT INTO line_usage_log(line_id,campaign_id,recipient_id,status,error_message,created_at) VALUES($1,$2,$3,'failed','[meta:131049] rejected',$4)",
      [a,campaign,recipient,'2026-10-18T15:00:10Z'])
  }
  it('counts an unequivocal queued Cloud rejection mirror once and still vetoes growth',async () => {
    await rejectedAttempt()
    await cloud({ status: 'queued',wamid: null,at: '2026-10-18T15:00:05Z' })
    const [line]=await getLineVolumeInputs([a],now)
    expect(day(line)).toMatchObject({ attempted: 1,accepted: 0,failed: 1,ecosystemRejected: 1,unknown: 0 })
    expect(line.evidenceIncomplete).toBe(true)
  })
  it('preserves multiple queued attempts as unknown instead of picking a convenient mirror',async () => {
    await rejectedAttempt()
    await cloud({ status: 'queued',wamid: null,at: '2026-10-18T15:00:04Z' })
    await cloud({ status: 'queued',wamid: null,at: '2026-10-18T15:00:05Z' })
    expect(day((await getLineVolumeInputs([a],now))[0])).toMatchObject({ attempted: 3,failed: 1,unknown: 2 })
  })
  it('never uses an accepted legacy message to erase another unknown Cloud attempt',async () => {
    await legacy({ at: '2026-10-18T15:00:10Z' })
    await cloud({ status: 'queued',wamid: null,at: '2026-10-18T15:00:05Z' })
    const [line]=await getLineVolumeInputs([a],now)
    expect(day(line)).toMatchObject({ attempted: 2,accepted: 1,delivered: 1,unknown: 1 });expect(line.evidenceIncomplete).toBe(true)
  })
  it.each([
    { to: '+54922222222' },{ campaign: id(99) },{ at: '2026-10-18T15:00:11Z' },{ at: '2026-10-18T14:59:59Z' },
  ])('does not merge an unrelated queue %j',async mismatch => {
    await rejectedAttempt()
    await cloud({ status: 'queued',wamid: null,at: '2026-10-18T15:00:05Z',...mismatch })
    expect(day((await getLineVolumeInputs([a],now))[0])).toMatchObject({ attempted: 2,failed: 1,unknown: 1 })
  })
  it('does not collapse a queue into a retried legacy recipient',async () => {
    await rejectedAttempt(2)
    await cloud({ status: 'queued',wamid: null,at: '2026-10-18T15:00:05Z' })
    expect(day((await getLineVolumeInputs([a],now))[0])).toMatchObject({ attempted: 2,failed: 1,unknown: 1 })
  })
})
