// @vitest-environment node
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const m=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn(),send:vi.fn(),post:vi.fn(),receive:vi.fn(),automation:vi.fn(),legacyStop:vi.fn(),token:vi.fn()}))
vi.mock('@/lib/db',()=>({query:m.query,withTransaction:m.transaction}))
vi.mock('@/lib/cloud-api/use-cases/send-message.use-case',()=>({sendMessageUseCase:{execute:m.send}}))
vi.mock('@/lib/cloud-api/token-store',()=>({getTokenForNumber:m.token}))
vi.mock('@/lib/cloud-api/rate-limiter',()=>({enforceRateLimit:vi.fn()}))
vi.mock('@/lib/cloud-api/infrastructure/meta-http.gateway',()=>({MetaHttpGateway:class {post=m.post}}))
vi.mock('@/lib/cloud-api/repositories/conversation.repository',()=>({conversationRepository:{receive:m.receive,updateContactDisplayName:vi.fn()}}))
vi.mock('@/lib/cloud-api/repositories/compliance.repository',()=>({complianceRepository:{recordOptOut:m.legacyStop,matchesStopKeyword:vi.fn().mockResolvedValue(false)}}))
vi.mock('@/lib/opt-out-confirmation',()=>({sendOptOutConfirmation:vi.fn()}))
vi.mock('@/lib/automation-engine',()=>({evaluateAutomations:m.automation}))
vi.mock('@/lib/sse-events',()=>({sseEmitter:{emit:vi.fn()}}))
import { handleInboundMessage } from '@/lib/cloud-api/webhook-handlers/inbound-message.handler'
import { saveSubscriptionSettings,assertLineSubscription,recordInboundSubscription } from '@/lib/line-subscriptions'
import { defaultSubscriptionFlow } from '@/lib/line-subscription-message'

const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002'
const phone='5491112345678',trigger='Quiero recibir promociones por whatsapp. Puedo cancelar escribiendo BAJA.'
const flow=defaultSubscriptionFlow('Commando BD')
describe.skipIf(!process.env.OPS_TEST_DATABASE_URL)('double opt-in: simulated inbound messages with real PostgreSQL',()=>{
  let pool:Pool,now:number
  const schema=`subscription_flow_${process.pid}`
  const deliver=async(text:string,id:string,seconds=0,source='cloud-9649',profile?:string)=>handleInboundMessage(source,
    {id,from:phone,timestamp:String(now+seconds),type:'text',text:{body:text}},profile?[{wa_id:phone,profile:{name:profile}}]:[],'test')
  const state=async(line=A)=>(await pool.query('SELECT * FROM whatsapp_line_subscribers WHERE line_id=$1 AND contact_phone=$2',[line,phone])).rows[0]
  beforeAll(async()=>{
    const url=new URL(process.env.OPS_TEST_DATABASE_URL!)
    if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('LOCAL_ONLY')
    pool=new Pool({connectionString:url.toString(),ssl:false,max:20,options:`-c search_path=${schema}`})
    await pool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY,line_type text,status text,is_connected boolean,sending_enabled boolean,evolution_instance text);
      CREATE TABLE cloud_numbers(whatsapp_line_id uuid,phone_number_id text PRIMARY KEY,status text);
      CREATE TABLE contacts(phone_number text,first_name text,deleted_at timestamptz);
      CREATE TABLE cloud_conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),phone_number_id text,contact_phone text,window_expires_at timestamptz,UNIQUE(phone_number_id,contact_phone));
      CREATE TABLE cloud_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid,phone_number_id text,wamid text UNIQUE,direction text,message_type text,content jsonb,status text,sent_at timestamptz,queued_at timestamptz,failed_at timestamptz,error_title text,error_details text);`)
    await pool.query(readFileSync('../db/migrations/166_line_subscriptions.sql','utf8'))
    const migration=readFileSync('../db/migrations/167_subscription_confirmation.sql','utf8')
    await pool.query(migration);await pool.query(migration)
    m.query.mockImplementation(async(sql,args)=>(await pool.query(sql,args)).rows)
    m.transaction.mockImplementation(async fn=>{
      const db=await pool.connect()
      try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result}
      catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}
    })
    m.receive.mockImplementation(async(source,contact,msg)=>{
      const {rows:[conversation]}=await pool.query(`INSERT INTO cloud_conversations(phone_number_id,contact_phone,window_expires_at)
        VALUES($1,$2,NOW()+interval '24 hours') ON CONFLICT(phone_number_id,contact_phone) DO UPDATE SET window_expires_at=EXCLUDED.window_expires_at RETURNING id`,[source,contact])
      await pool.query(`INSERT INTO cloud_messages(conversation_id,phone_number_id,wamid,direction,sent_at)
        VALUES($1,$2,$3,'inbound',to_timestamp($4)) ON CONFLICT(wamid) DO NOTHING`,[conversation.id,source,msg.id,Number(msg.timestamp)])
    })
  })
  afterAll(async()=>{if(pool){await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()}})
  beforeEach(async()=>{
    vi.clearAllMocks();now=Math.floor(Date.now()/1000)-100
    await pool.query('TRUNCATE whatsapp_lines,cloud_numbers,contacts,cloud_messages,cloud_conversations CASCADE')
    await pool.query(`INSERT INTO whatsapp_lines VALUES($1,'cloud','active',true,true,NULL),($2,'cloud','active',true,true,NULL);
    `,[A,B])
    await pool.query("INSERT INTO cloud_numbers VALUES($1,'cloud-9649','active'),($2,'cloud-other','active')",[A,B])
    await saveSubscriptionSettings(A,'Commando BD',trigger,true,flow)
    await saveSubscriptionSettings(B,'Otro negocio',trigger,true)
    await pool.query("UPDATE whatsapp_subscription_settings SET active_since=NOW()-interval '1 day'")
    m.token.mockResolvedValue('simulated-token')
    m.send.mockImplementation(async()=>({messageId:randomUUID(),wamid:'simulated-'+randomUUID(),status:'sent'}))
    m.post.mockImplementation(async()=>({messages:[{id:'simulated-'+randomUUID()}]}))
  })
  it('completes request → pending → OK → consent → BAJA only on the intended line, keeping evidence and all three replies',async()=>{
    await pool.query('INSERT INTO contacts VALUES($1,$2,NULL)',[phone,'Lucía'])
    await deliver(trigger,'start')
    expect((await state()).status).toBe('pending')
    expect(m.legacyStop).not.toHaveBeenCalled()
    expect(m.send.mock.calls[0][0].request.text.body).toBe(flow.welcome.replace('{{nombre}}','Lucía'))
    await expect(assertLineSubscription(A,phone)).rejects.toThrow('todavía no autorizó')
    await deliver('  oK  ','confirm',1)
    expect((await state()).status).toBe('subscribed')
    await expect(assertLineSubscription(A,phone)).resolves.toBeUndefined()
    await expect(assertLineSubscription(B,phone)).rejects.toThrow('todavía no autorizó')
    expect(m.send.mock.calls[1][0].request.text.body).toBe(flow.confirmation)
    const consent=(await pool.query("SELECT * FROM whatsapp_subscription_events WHERE event='subscribed'")).rows[0]
    expect(consent).toMatchObject({line_id:A,message_id:'confirm',message_text:'  oK  ',brand_name:'Commando BD'})
    expect(consent.occurred_at.getTime()).toBe((now+1)*1000)
    expect(consent.recorded_at).toBeInstanceOf(Date);expect(consent.request_event_id).toBeTruthy()
    expect(consent.expected_message).toContain('Lucía')
    await deliver('BAJA','stop',2)
    expect((await state()).status).toBe('unsubscribed')
    await expect(assertLineSubscription(A,phone)).rejects.toThrow('BAJA')
    expect(m.post).toHaveBeenCalledOnce()
    expect(m.post.mock.calls[0][1].text.body).toBe(flow.goodbye)
    expect(m.legacyStop).not.toHaveBeenCalled()
    expect((await pool.query("SELECT status FROM whatsapp_subscription_replies")).rows.every(r=>r.status==='sent')).toBe(true)
  })
  it.each(['OK','ok','Ok','  ok  '])('accepts %j only after a pending request',async ok=>{
    await deliver(ok,'ordinary',-1)
    expect(await state()).toBeUndefined();expect(m.send).not.toHaveBeenCalled()
    await deliver(trigger.replace(/\.$/,''),'start')
    expect(m.send.mock.calls[0][0].request.text.body).toBe(flow.welcome.replace(', {{nombre}}',''))
    await deliver(ok,'confirm',1)
    expect((await state()).status).toBe('subscribed')
  })
  it('deduplicates concurrent requests, confirmations and BAJA before the provider call',async()=>{
    await Promise.all(Array.from({length:5},()=>deliver(trigger,'start')))
    expect(m.send).toHaveBeenCalledOnce()
    await Promise.all(Array.from({length:5},()=>deliver('ok','confirm',1)))
    await deliver('OK','another-ok',2)
    expect(m.send).toHaveBeenCalledTimes(2)
    await Promise.all(Array.from({length:5},()=>deliver('BAJA','stop',3)))
    expect(m.post).toHaveBeenCalledOnce()
    expect((await pool.query('SELECT * FROM whatsapp_subscription_events')).rows).toHaveLength(3)
  })
  it('cancels pending on BAJA; subsequent OK and delayed request cannot subscribe or duplicate the welcome',async()=>{
    await deliver(trigger,'start');await deliver('BAJA','stop',2);await deliver('OK','late-ok',3)
    await deliver(trigger,'delayed-request',1);await deliver('OK','delayed-ok',1)
    expect((await state()).status).toBe('unsubscribed');expect(m.send).toHaveBeenCalledOnce()
    await deliver(trigger,'new-request',4);await deliver('ok','new-confirm',5)
    expect((await state()).status).toBe('subscribed');expect(m.send).toHaveBeenCalledTimes(3)
  })
  it('never reinterprets an already seen ordinary OK as a later confirmation',async()=>{
    await deliver('OK','ordinary-ok',1)
    await deliver(trigger,'start')
    await deliver('OK','ordinary-ok',1)
    expect((await state()).status).toBe('pending');expect(m.send).toHaveBeenCalledOnce()
  })
  it('leaves all other lines on their previous single-step flow and ignores OK there',async()=>{
    await deliver('OK','other-ok',0,'cloud-other')
    expect(await state(B)).toBeUndefined()
    await deliver(trigger,'other-request',1,'cloud-other')
    expect((await state(B)).status).toBe('subscribed')
    expect(await state()).toBeUndefined();expect(m.send).not.toHaveBeenCalled()
  })
  it('a BAJA on the benefits line does not revoke another line subscription',async()=>{
    await deliver(trigger,'other-request',0,'cloud-other')
    await deliver(trigger,'start');await deliver('OK','confirm',1);await deliver('BAJA','stop',2)
    await expect(assertLineSubscription(A,phone)).rejects.toThrow('BAJA')
    await expect(assertLineSubscription(B,phone)).resolves.toBeUndefined()
    expect(m.legacyStop).not.toHaveBeenCalled()
  })
  it('does not replay an ambiguous provider send on duplicate delivery',async()=>{
    m.send.mockRejectedValueOnce(Error('timeout after acceptance'))
    await deliver(trigger,'start');await deliver(trigger,'start')
    expect(m.send).toHaveBeenCalledOnce()
    expect((await pool.query('SELECT status FROM whatsapp_subscription_replies')).rows[0].status).toBe('uncertain')
  })
  it('persists the attempted BAJA reply and never repeats it after an ambiguous provider result',async()=>{
    m.post.mockRejectedValueOnce(Error('timeout after acceptance'))
    await deliver('BAJA','stop');await deliver('BAJA','stop')
    expect((await state()).status).toBe('unsubscribed');expect(m.post).toHaveBeenCalledOnce()
    const history=(await pool.query("SELECT status,content FROM cloud_messages WHERE direction='outbound'")).rows
    expect(history).toHaveLength(1);expect(history[0].status).toBe('failed')
    expect(history[0].content.text.body).toBe(flow.goodbye)
  })
  it('does not send from an inactive line, while retaining the incoming request',async()=>{
    await pool.query('UPDATE whatsapp_lines SET sending_enabled=false WHERE id=$1',[A])
    await deliver(trigger,'start')
    expect((await state()).status).toBe('pending');expect(m.send).not.toHaveBeenCalled()
    expect((await pool.query('SELECT status FROM whatsapp_subscription_replies')).rows[0].status).toBe('skipped')
  })
  it('retries pre-send credential failure without losing pending state or sending twice',async()=>{
    m.token.mockRejectedValueOnce(Error('credentials temporarily unavailable'))
    await expect(deliver(trigger,'start')).rejects.toThrow('credentials')
    expect((await state()).status).toBe('pending');expect(m.send).not.toHaveBeenCalled()
    await deliver(trigger,'start');expect(m.send).toHaveBeenCalledOnce()
  })
  it('keeps BAJA ahead of an equal-time request and invalidates pending OK after edited terms',async()=>{
    await deliver('BAJA','stop');await deliver(trigger,'same-time-request')
    expect((await state()).status).toBe('unsubscribed')
    await deliver(trigger,'start',1)
    await saveSubscriptionSettings(A,'Commando BD',trigger,true,{...flow,welcome:flow.welcome+' Confirmación nueva.'})
    await deliver('OK','old-confirm',200)
    expect((await state()).status).toBe('pending')
    await expect(assertLineSubscription(A,phone)).rejects.toThrow()
  })
  it('cannot bypass double opt-in through the older single-step handler',async()=>{
    expect(await recordInboundSubscription({provider:'cloud',sourceId:'cloud-9649',phone,text:trigger,messageId:'bypass',timestamp:now})).toBe(false)
    expect(await state()).toBeUndefined()
  })
  it('uses the profile name when no CRM name exists and stops new requests when capture is disabled',async()=>{
    await deliver(trigger,'start',0,'cloud-9649','Sofía')
    expect(m.send.mock.calls[0][0].request.text.body).toContain('¡Hola, Sofía!')
    await saveSubscriptionSettings(A,'Commando BD',trigger,false)
    await deliver('OK','disabled-ok',1);expect((await state()).status).toBe('pending')
    await deliver('BAJA','disabled-stop',2);expect((await state()).status).toBe('unsubscribed')
    expect(m.post).toHaveBeenCalledOnce()
  })
  it('keeps the new receipts and reply tables private',async()=>{
    const rows=(await pool.query("SELECT relrowsecurity FROM pg_class WHERE relnamespace=$1::regnamespace AND relname IN ('whatsapp_subscription_flow_receipts','whatsapp_subscription_replies')",[schema])).rows
    expect(rows).toHaveLength(2);expect(rows.every(r=>r.relrowsecurity)).toBe(true)
  })
})
