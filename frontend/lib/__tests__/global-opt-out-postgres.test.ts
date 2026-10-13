// @vitest-environment node
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
const m=vi.hoisted(()=>({query:vi.fn(),tx:vi.fn()}))
vi.mock('@/lib/db',()=>({query:m.query,withTransaction:m.tx}))
import { recordGlobalOptOut, reinstateGlobalContact, isGloballyOptedOut, withGlobalSendGuard } from '@/lib/global-opt-out'
import { complianceRepository } from '@/lib/cloud-api/repositories/compliance.repository'
import { sendQueuedWithConsent } from '@/lib/cloud-api/queued-send-guard'
import { OptOutError } from '@/lib/cloud-api/errors'

const phone='5491100000001', id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const request={phone:'+'+phone,sourceId:'line-1',provider:'cloud' as const,messageId:'baja-1',text:'BAJA',metadata:{input_type:'button'}}
describe.skipIf(!process.env.OPS_TEST_DATABASE_URL)('global consent with real local PostgreSQL and no provider calls',()=>{
  let pool:Pool
  const schema=`global_consent_${process.pid}`
  beforeAll(async()=>{
    const url=new URL(process.env.OPS_TEST_DATABASE_URL!)
    if(!['127.0.0.1','localhost'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    pool=new Pool({connectionString:url.toString(),ssl:false,max:6,options:`-c search_path=${schema}`})
    await pool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE campaigns(id uuid PRIMARY KEY);
      CREATE TABLE contacts(phone_number text,opt_in_marketing boolean);
      CREATE TABLE whatsapp_messages(phone_number text,direction text,status text,campaign_id uuid,created_at timestamptz DEFAULT NOW());
      CREATE TABLE campaign_recipients(id uuid,status text,phone_number text,locked_at timestamptz,error_detail text,updated_at timestamptz);
      CREATE TABLE automation_message_jobs(id uuid,phone text,status text,finished_at timestamptz,details text);
      CREATE TABLE cloud_conversations(id uuid PRIMARY KEY,contact_phone text);
      CREATE TABLE cloud_messages(id uuid PRIMARY KEY,conversation_id uuid,direction text,status text,wamid text,failed_at timestamptz,error_code int,error_title text,error_details text);
    `)
    await pool.query(readFileSync('../db/migrations/041_blacklist.sql','utf8'))
    await pool.query(readFileSync('../db/migrations/069_cloud_api_opt_outs.sql','utf8'))
    m.query.mockImplementation(async(sql,params)=>(await pool.query(sql,params)).rows)
    m.tx.mockImplementation(async fn=>{const db=await pool.connect();try{await db.query('BEGIN');const value=await fn(db);await db.query('COMMIT');return value}catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}})
  })
  beforeEach(async()=>{
    await pool.query(`TRUNCATE blacklist,cloud_opt_outs,cloud_consent_log,whatsapp_messages,campaign_recipients,automation_message_jobs,cloud_messages,cloud_conversations,contacts,users,campaigns CASCADE;
      INSERT INTO users VALUES('${id(1)}');INSERT INTO campaigns VALUES('${id(2)}');
      INSERT INTO contacts VALUES('+${phone}',true);
      INSERT INTO whatsapp_messages VALUES('+${phone}','outbound','sent','${id(2)}',NOW());
      INSERT INTO campaign_recipients VALUES('${id(3)}','pending','${phone}',NULL,NULL,NOW()),('${id(4)}','sent','+${phone}',NULL,NULL,NOW());
      INSERT INTO automation_message_jobs(id,phone,status) VALUES('${id(5)}','${phone}','queued');
      INSERT INTO cloud_conversations VALUES('${id(6)}','+${phone}');
      INSERT INTO cloud_messages(id,conversation_id,direction,status) VALUES('${id(7)}','${id(6)}','outbound','queued');`)
  })
  afterAll(async()=>{await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()})

  it('records a single global blacklist entry and receipt under concurrent webhook retries',async()=>{
    await Promise.all([recordGlobalOptOut(request),recordGlobalOptOut(request),recordGlobalOptOut({...request,phone:'+54 9 11 0000-0001'})])
    expect((await pool.query('SELECT count(*)::int AS n FROM blacklist')).rows[0].n).toBe(1)
    const logs=(await pool.query('SELECT * FROM cloud_consent_log')).rows
    expect(logs).toHaveLength(1);expect(logs[0].metadata).toMatchObject({scope:'global',input_type:'button',campaign_id:id(2)})
    expect((await pool.query('SELECT status FROM campaign_recipients ORDER BY id')).rows).toEqual([{status:'skipped'},{status:'sent'}])
    expect((await pool.query('SELECT status,details FROM automation_message_jobs')).rows[0]).toMatchObject({status:'skipped',details:'Baja solicitada por el contacto'})
    expect((await pool.query('SELECT status,error_title,error_code FROM cloud_messages')).rows[0]).toEqual({status:'failed',error_title:'global-opt-out',error_code:null})
  })
  it('blocks all eight lines, future lines, manual sends and contact reimports',async()=>{
    await recordGlobalOptOut(request)
    await pool.query('UPDATE contacts SET opt_in_marketing=true')
    for (const line of ['line-1','line-2','line-3','line-4','line-5','line-6','line-7','line-8','future-line']) {
      expect(await complianceRepository.isOptedOut('+'+phone,line)).toBe(true)
    }
    const provider=vi.fn()
    await expect(withGlobalSendGuard('+54 9 11 0000-0001',provider)).rejects.toBeInstanceOf(OptOutError)
    expect(provider).not.toHaveBeenCalled()
    expect((await pool.query('SELECT * FROM contacts')).rows).toHaveLength(1)
  })
  it('requires recorded consent and keeps old queued jobs cancelled after reinstatement',async()=>{
    await recordGlobalOptOut(request)
    const entry=(await pool.query('SELECT id FROM blacklist')).rows[0].id
    await expect(reinstateGlobalContact(entry,id(1),'')).rejects.toThrow('consentimiento')
    expect(await isGloballyOptedOut(phone)).toBe(true)
    await expect(complianceRepository.recordOptIn({phone,phoneNumberId:'line-8',channel:'manual'})).rejects.toThrow('Blacklist')
    expect(await reinstateGlobalContact(entry,id(1),'Aceptó por WhatsApp el 13/10/2026')).toBe(true)
    expect(await isGloballyOptedOut(phone)).toBe(false)
    const provider=vi.fn().mockResolvedValue('sent')
    expect(await sendQueuedWithConsent(id(7),phone,provider)).toBe(null)
    expect(provider).not.toHaveBeenCalled()
    expect(await withGlobalSendGuard(phone,provider)).toBe('sent')
    expect((await pool.query("SELECT metadata FROM cloud_consent_log WHERE event='reinstated'")).rows[0].metadata.consent).toContain('Aceptó')
  })
  it('does not replay a previous BAJA after reactivation, but honors a new request',async()=>{
    await recordGlobalOptOut(request)
    const entry=(await pool.query('SELECT id FROM blacklist')).rows[0].id
    await reinstateGlobalContact(entry,id(1),'Nuevo consentimiento explícito registrado')
    await recordGlobalOptOut(request)
    expect(await isGloballyOptedOut(phone)).toBe(false)
    await recordGlobalOptOut({...request,messageId:'baja-2',sourceId:'line-8'})
    expect(await isGloballyOptedOut(phone)).toBe(true)
    expect((await pool.query('SELECT count(*)::int AS n FROM blacklist')).rows[0].n).toBe(2)
  })
  it('serializes provider submission and BAJA for the same phone',async()=>{
    let release!:()=>void, entered!:()=>void
    const started=new Promise<void>(resolve=>{entered=resolve})
    const sending=withGlobalSendGuard(phone,async()=>{entered();await new Promise<void>(resolve=>{release=resolve});return 'accepted'})
    await started
    const optOut=recordGlobalOptOut(request)
    release();expect(await sending).toBe('accepted');await optOut
    const next=vi.fn()
    await expect(withGlobalSendGuard(phone,next)).rejects.toBeInstanceOf(OptOutError)
    expect(next).not.toHaveBeenCalled()
  })
  it('rolls back the entire event if consent persistence fails, allowing a retry',async()=>{
    await pool.query(`CREATE FUNCTION fail_consent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'consent unavailable'; END $$;
      CREATE TRIGGER fail_consent BEFORE INSERT ON cloud_consent_log FOR EACH ROW EXECUTE FUNCTION fail_consent();`)
    await expect(recordGlobalOptOut(request)).rejects.toThrow('consent unavailable')
    expect((await pool.query('SELECT * FROM blacklist')).rows).toHaveLength(0)
    expect((await pool.query('SELECT * FROM cloud_opt_outs')).rows).toHaveLength(0)
    await pool.query('DROP TRIGGER fail_consent ON cloud_consent_log;DROP FUNCTION fail_consent()')
    await recordGlobalOptOut(request);expect(await isGloballyOptedOut(phone)).toBe(true)
  })
  it('treats historical opt-outs and Evolution requests as global and completes blocked jobs locally',async()=>{
    await pool.query("INSERT INTO cloud_opt_outs VALUES($1,'old-line',true,NOW(),'stop_keyword')",['+'+phone])
    const send=vi.fn()
    expect(await sendQueuedWithConsent(id(7),phone,send)).toBe(null);expect(send).not.toHaveBeenCalled()
    await recordGlobalOptOut({...request,provider:'evolution',sourceId:'instance-a'})
    expect((await pool.query("SELECT phone_number_id FROM cloud_consent_log WHERE event='opt_out'")).rows[0].phone_number_id).toBe('evolution:instance-a')
  })
})
