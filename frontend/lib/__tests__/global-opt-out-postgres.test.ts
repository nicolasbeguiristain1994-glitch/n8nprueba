// @vitest-environment node
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
const m=vi.hoisted(()=>({query:vi.fn(),tx:vi.fn(),post:vi.fn(),token:vi.fn(),limit:vi.fn()}))
vi.mock('@/lib/db',()=>({query:m.query,withTransaction:m.tx}))
vi.mock('@/lib/cloud-api/token-store',()=>({getTokenForNumber:m.token}))
vi.mock('@/lib/cloud-api/rate-limiter',()=>({enforceRateLimit:m.limit}))
vi.mock('@/lib/cloud-api/infrastructure/meta-http.gateway',()=>({MetaHttpGateway:class {post=m.post}}))
import { recordGlobalOptOut, reinstateGlobalContact, isGloballyOptedOut, withGlobalSendGuard } from '@/lib/global-opt-out'
import { complianceRepository } from '@/lib/cloud-api/repositories/compliance.repository'
import { sendQueuedWithConsent } from '@/lib/cloud-api/queued-send-guard'
import { OptOutError } from '@/lib/cloud-api/errors'
import { sendOptOutConfirmation, OPT_OUT_CONFIRMATION } from '@/lib/opt-out-confirmation'
import { getOptOutAutomation, saveOptOutMessage } from '@/lib/opt-out-settings'

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
      CREATE TABLE whatsapp_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),phone_number text,message_body text,direction text,status text,campaign_id uuid,created_at timestamptz DEFAULT NOW(),updated_at timestamptz,evolution_message_id text,metadata jsonb);
      CREATE TABLE campaign_recipients(id uuid,status text,phone_number text,locked_at timestamptz,error_detail text,updated_at timestamptz);
      CREATE TABLE automation_message_jobs(id uuid,phone text,status text,finished_at timestamptz,details text);
      CREATE TABLE cloud_conversations(id uuid PRIMARY KEY,contact_phone text,phone_number_id text,window_expires_at timestamptz);
      CREATE TABLE cloud_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid,phone_number_id text,direction text,message_type text,content jsonb,status text,wamid text,queued_at timestamptz,sent_at timestamptz,failed_at timestamptz,error_code int,error_title text,error_details text);
      CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY,evolution_instance text,evolution_url text,line_type text,status text,is_connected boolean,sending_enabled boolean);
      CREATE TABLE cloud_numbers(phone_number_id text,whatsapp_line_id uuid,status text);
    `)
    await pool.query(readFileSync('../db/migrations/041_blacklist.sql','utf8'))
    await pool.query(readFileSync('../db/migrations/069_cloud_api_opt_outs.sql','utf8'))
    await pool.query(readFileSync('../db/migrations/038_app_settings.sql','utf8'))
    m.query.mockImplementation(async(sql,params)=>(await pool.query(sql,params)).rows)
    m.tx.mockImplementation(async fn=>{const db=await pool.connect();try{await db.query('BEGIN');const value=await fn(db);await db.query('COMMIT');return value}catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}})
  })
  beforeEach(async()=>{
    m.post.mockReset();m.token.mockReset();m.limit.mockReset()
    m.post.mockResolvedValue({messages:[{id:'ack-wamid'}]});m.token.mockResolvedValue('local-token');m.limit.mockResolvedValue(undefined)
    await pool.query(`TRUNCATE app_settings,blacklist,cloud_opt_outs,cloud_consent_log,whatsapp_messages,campaign_recipients,automation_message_jobs,cloud_messages,cloud_conversations,contacts,users,campaigns,whatsapp_lines,cloud_numbers CASCADE;
      INSERT INTO users VALUES('${id(1)}');INSERT INTO campaigns VALUES('${id(2)}');
      INSERT INTO contacts VALUES('+${phone}',true);
      INSERT INTO whatsapp_messages(phone_number,direction,status,campaign_id) VALUES('+${phone}','outbound','sent','${id(2)}');
      INSERT INTO campaign_recipients VALUES('${id(3)}','pending','${phone}',NULL,NULL,NOW()),('${id(4)}','sent','+${phone}',NULL,NULL,NOW());
      INSERT INTO automation_message_jobs(id,phone,status) VALUES('${id(5)}','${phone}','queued');
      INSERT INTO cloud_conversations VALUES('${id(6)}','+${phone}','line-1',NOW()+interval '24 hours');
      INSERT INTO cloud_messages(id,conversation_id,direction,status) VALUES('${id(7)}','${id(6)}','outbound','queued');
      INSERT INTO cloud_messages(conversation_id,phone_number_id,direction,status,wamid,sent_at) VALUES('${id(6)}','line-1','inbound','delivered','baja-1',NOW());
      INSERT INTO whatsapp_lines VALUES('${id(8)}',NULL,NULL,'cloud','active',true,true);
      INSERT INTO cloud_numbers VALUES('line-1','${id(8)}','active');`)
  })
  afterAll(async()=>{await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()})

  it('records a single global blacklist entry and receipt under concurrent webhook retries',async()=>{
    await Promise.all([recordGlobalOptOut(request),recordGlobalOptOut(request),recordGlobalOptOut({...request,phone:'+54 9 11 0000-0001'})])
    expect((await pool.query('SELECT count(*)::int AS n FROM blacklist')).rows[0].n).toBe(1)
    const logs=(await pool.query('SELECT * FROM cloud_consent_log')).rows
    expect(logs).toHaveLength(1);expect(logs[0].metadata).toMatchObject({scope:'global',input_type:'button',campaign_id:id(2)})
    expect((await pool.query('SELECT status FROM campaign_recipients ORDER BY id')).rows).toEqual([{status:'skipped'},{status:'sent'}])
    expect((await pool.query('SELECT status,details FROM automation_message_jobs')).rows[0]).toMatchObject({status:'skipped',details:'Baja solicitada por el contacto'})
    expect((await pool.query("SELECT status,error_title,error_code FROM cloud_messages WHERE direction='outbound'")).rows[0]).toEqual({status:'failed',error_title:'global-opt-out',error_code:null})
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

  it('confirms BAJA once under concurrent retries, records the text, and keeps every ordinary send blocked',async()=>{
    await recordGlobalOptOut({...request,confirmation:true})
    m.post.mockImplementation(async()=>{
      expect(await isGloballyOptedOut(phone)).toBe(true)
      expect((await pool.query("SELECT status FROM cloud_messages WHERE content->>'source'='opt_out_confirmation'")).rows).toEqual([{status:'queued'}])
      return {messages:[{id:'ack-wamid'}]}
    })
    await Promise.all([sendOptOutConfirmation(request),sendOptOutConfirmation(request),sendOptOutConfirmation(request)])
    await sendOptOutConfirmation(request)
    expect(m.post).toHaveBeenCalledOnce()
    expect(m.post).toHaveBeenCalledWith('/line-1/messages',expect.objectContaining({to:phone,type:'text',text:{body:OPT_OUT_CONFIRMATION,preview_url:false}}))
    expect(m.limit).toHaveBeenCalledWith('line-1')
    expect((await pool.query("SELECT status,wamid,content FROM cloud_messages WHERE content->>'source'='opt_out_confirmation'")).rows).toEqual([
      {status:'sent',wamid:'ack-wamid',content:{text:{body:OPT_OUT_CONFIRMATION},source:'opt_out_confirmation'}},
    ])
    expect((await pool.query('SELECT metadata FROM cloud_consent_log')).rows[0].metadata.confirmation.status).toBe('sent')
    await expect(withGlobalSendGuard(phone,vi.fn())).rejects.toBeInstanceOf(OptOutError)
  })
  it('never confirms an absent, manual, old, different-line or reinstated receipt',async()=>{
    await sendOptOutConfirmation(request)
    await recordGlobalOptOut(request)
    await sendOptOutConfirmation(request)
    expect(m.post).not.toHaveBeenCalled()
    await pool.query('DELETE FROM cloud_consent_log')
    await recordGlobalOptOut({...request,confirmation:true})
    await sendOptOutConfirmation({...request,sourceId:'line-9'})
    const entry=(await pool.query('SELECT id FROM blacklist')).rows[0].id
    await reinstateGlobalContact(entry,id(1),'Nuevo consentimiento explícito para pruebas')
    await sendOptOutConfirmation(request)
    expect(m.post).not.toHaveBeenCalled()
  })
  it('persists edits and captures the same text for Cloud and history despite an edit during sending', async()=>{
    expect((await getOptOutAutomation()).action_config.message).toBe(OPT_OUT_CONFIRMATION)
    const message='Disculpá las molestias. Tu baja quedó registrada. Gracias.'
    await saveOptOutMessage('  '+message+'  ',id(1))
    expect((await getOptOutAutomation()).action_config.message).toBe(message)
    expect((await pool.query('SELECT updated_by FROM app_settings')).rows[0].updated_by).toBe(id(1))
    await recordGlobalOptOut({...request,confirmation:true})
    m.token.mockImplementationOnce(async()=>{await saveOptOutMessage('Texto para futuras bajas',id(1));return 'local-token'})
    await sendOptOutConfirmation(request)
    expect(m.post).toHaveBeenCalledWith('/line-1/messages',expect.objectContaining({text:{body:message,preview_url:false}}))
    expect((await pool.query("SELECT content FROM cloud_messages WHERE content->>'source'='opt_out_confirmation'")).rows[0].content.text.body).toBe(message)
    expect((await getOptOutAutomation()).action_config.message).toBe('Texto para futuras bajas')
    await sendOptOutConfirmation(request)
    expect(m.post).toHaveBeenCalledOnce()
    expect(await isGloballyOptedOut(phone)).toBe(true)
  })
  it('keeps the receipt pending if reading the reply fails, then uses the saved text on retry',async()=>{
    await saveOptOutMessage('Baja confirmada. Disculpá las molestias.',id(1))
    await recordGlobalOptOut({...request,confirmation:true})
    const original=m.query.getMockImplementation()!
    m.query.mockImplementationOnce(original).mockRejectedValueOnce(Error('Settings unavailable'))
    await expect(sendOptOutConfirmation(request)).rejects.toThrow('Settings unavailable')
    expect(m.post).not.toHaveBeenCalled()
    expect((await pool.query('SELECT metadata FROM cloud_consent_log')).rows[0].metadata.confirmation.status).toBe('pending')
    await sendOptOutConfirmation(request)
    expect(m.post).toHaveBeenCalledWith('/line-1/messages',expect.objectContaining({text:{body:'Baja confirmada. Disculpá las molestias.',preview_url:false}}))
  })
  it.each(['window','old-message','disabled-line'])('does not confirm when the origin is unavailable: %s',async(reason)=>{
    await recordGlobalOptOut({...request,confirmation:true})
    if(reason==='window') await pool.query("UPDATE cloud_conversations SET window_expires_at=NOW()-interval '1 hour'")
    if(reason==='old-message') await pool.query("UPDATE cloud_messages SET sent_at=NOW()-interval '25 hours' WHERE direction='inbound'")
    if(reason==='disabled-line') await pool.query('UPDATE whatsapp_lines SET sending_enabled=false')
    await sendOptOutConfirmation(request)
    expect(m.post).not.toHaveBeenCalled();expect(await isGloballyOptedOut(phone)).toBe(true)
    expect((await pool.query('SELECT metadata FROM cloud_consent_log')).rows[0].metadata.confirmation.status).toBe('skipped')
  })
  it('allows retry before provider submission but never duplicates an ambiguous provider response',async()=>{
    await recordGlobalOptOut({...request,confirmation:true})
    m.limit.mockRejectedValueOnce(Error('Rate limit reached'))
    await expect(sendOptOutConfirmation(request)).rejects.toThrow('Rate limit')
    expect(m.post).not.toHaveBeenCalled()
    expect((await pool.query('SELECT metadata FROM cloud_consent_log')).rows[0].metadata.confirmation.status).toBe('pending')
    m.post.mockRejectedValueOnce(Error('Provider timeout'))
    await sendOptOutConfirmation(request);await sendOptOutConfirmation(request)
    expect(m.post).toHaveBeenCalledOnce()
    expect((await pool.query('SELECT metadata FROM cloud_consent_log')).rows[0].metadata.confirmation.status).toBe('uncertain')
    expect((await pool.query("SELECT status,error_title FROM cloud_messages WHERE content->>'source'='opt_out_confirmation'")).rows[0]).toEqual({status:'failed',error_title:'confirmation_uncertain'})
    expect(await isGloballyOptedOut(phone)).toBe(true)
  })
  it('does not call the provider if history cannot be persisted, and safely retries that receipt',async()=>{
    await recordGlobalOptOut({...request,confirmation:true})
    await pool.query(`CREATE FUNCTION fail_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'history unavailable'; END $$;
      CREATE TRIGGER fail_confirmation BEFORE INSERT ON cloud_messages FOR EACH ROW EXECUTE FUNCTION fail_confirmation();`)
    await expect(sendOptOutConfirmation(request)).rejects.toThrow('history unavailable')
    expect(m.post).not.toHaveBeenCalled()
    expect((await pool.query('SELECT metadata FROM cloud_consent_log')).rows[0].metadata.confirmation.status).toBe('pending')
    await pool.query('DROP TRIGGER fail_confirmation ON cloud_messages;DROP FUNCTION fail_confirmation()')
    await sendOptOutConfirmation(request);expect(m.post).toHaveBeenCalledOnce()
  })
  it('confirms an Evolution request using only its inbound line and persists its provider ID',async()=>{
    const evo={...request,provider:'evolution' as const,sourceId:'instance-a',confirmation:true}
    vi.stubEnv('EVOLUTION_GLOBAL_API_KEY','evo-test-key')
    const fetch=vi.fn().mockResolvedValue(Response.json({key:{id:'evo-ack'}}));vi.stubGlobal('fetch',fetch)
    try {
      const message='Disculpá las molestias. No recibirás más promociones.'
      await saveOptOutMessage(message,id(1))
      await pool.query(`INSERT INTO whatsapp_lines VALUES('${id(9)}','instance-a','https://evo.example.test','evolution','active',true,true);
        INSERT INTO whatsapp_messages(phone_number,direction,status,evolution_message_id) VALUES('${phone}','inbound','received','baja-1');`)
      await recordGlobalOptOut(evo)
      await Promise.all([sendOptOutConfirmation(evo),sendOptOutConfirmation(evo)])
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledWith('https://evo.example.test/message/sendText/instance-a',expect.objectContaining({body:JSON.stringify({number:phone,text:message})}))
      expect((await pool.query("SELECT status,evolution_message_id,message_body,metadata FROM whatsapp_messages WHERE metadata->>'source'='opt_out_confirmation'")).rows[0]).toMatchObject({status:'sent',evolution_message_id:'evo-ack',message_body:message,metadata:{line_id:id(9)}})
      expect(m.post).not.toHaveBeenCalled();expect(await isGloballyOptedOut(phone)).toBe(true)
    } finally {vi.unstubAllGlobals();vi.unstubAllEnvs()}
  })
})
