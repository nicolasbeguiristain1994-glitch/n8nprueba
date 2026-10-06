// @vitest-environment node
import {afterAll,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest'
import {Pool} from 'pg'
import {readFileSync} from 'node:fs'
const m=vi.hoisted(()=>({query:vi.fn(),tx:vi.fn(),send:vi.fn(),emit:vi.fn()}))
vi.mock('@/lib/db',()=>({query:m.query,withTransaction:m.tx}))
vi.mock('@/lib/cloud-api/use-cases/send-message.use-case',()=>({sendMessageUseCase:{execute:m.send}}))
vi.mock('@/lib/sse-events',()=>({sseEmitter:{emit:m.emit}}))
import {evaluateAutomations,processAutomationJobs,automationMatches,automationSteps} from '@/lib/automation-engine'
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const phone='5491100000001',source={provider:'cloud' as const,phoneNumberId:'phone-a'}
describe.skipIf(!process.env.OPS_TEST_DATABASE_URL && process.env.RUN_CAMPAIGN_PG_TESTS!=='1')('durable automations with simulated Cloud provider',()=>{
 let pool:Pool
 const schema=`automation_completion_${process.pid}`
 beforeAll(async()=>{
  const url=new URL(process.env.OPS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL!);if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('LOCAL_ONLY')
  pool=new Pool({connectionString:url.toString(),ssl:false,max:5,options:`-c search_path=${schema}`})
  await pool.query(`CREATE SCHEMA ${schema};CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,role text);
   CREATE TABLE automations(id uuid PRIMARY KEY,name text,type text,trigger_type text,trigger_config jsonb,action_config jsonb,created_by uuid,is_active boolean,priority int,created_at timestamptz DEFAULT NOW());
   CREATE TABLE whatsapp_messages(id uuid PRIMARY KEY);
   CREATE TABLE automation_logs(automation_id uuid,automation_name text,conversation_phone text,message_id uuid,result text,details text);
   CREATE TABLE conversation_state(phone_number text,is_escalated boolean,escalated_at timestamptz,escalation_reason text,resolved_at timestamptz,updated_at timestamptz);
   CREATE UNIQUE INDEX active_conversation ON conversation_state(phone_number) WHERE resolved_at IS NULL;
   CREATE TABLE blacklist(phone_number_normalized text,removed_at timestamptz);
   CREATE TABLE contacts(phone_number text,first_name text,panel text,linea int,linea_sub text,deleted_at timestamptz);
   CREATE TABLE cloud_numbers(phone_number_id text,whatsapp_line_id uuid,status text);
   CREATE TABLE whatsapp_lines(id uuid,status text,is_connected boolean,sending_enabled boolean);
   INSERT INTO users VALUES('${id(1)}',true,'admin');INSERT INTO contacts(phone_number,first_name,panel) VALUES('${phone}','Ana','Panel');
   INSERT INTO whatsapp_lines VALUES('${id(2)}','active',true,true);INSERT INTO cloud_numbers VALUES('phone-a','${id(2)}','active'),('phone-b','${id(2)}','active');`)
  await pool.query(readFileSync('../db/migrations/134_automation_delivery_jobs.sql','utf8'))
  m.query.mockImplementation(async(sql,params)=>(await pool.query(sql,params)).rows)
  m.tx.mockImplementation(async fn=>{const db=await pool.connect();try{await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r}catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}})
 })
 beforeEach(async()=>{
  await pool.query(`TRUNCATE automation_message_jobs,automation_inbound_receipts,automations,automation_logs,conversation_state,blacklist;UPDATE contacts SET panel='Panel',linea=NULL,linea_sub=NULL,deleted_at=NULL;UPDATE users SET is_active=true;UPDATE whatsapp_lines SET sending_enabled=true;
   INSERT INTO automations VALUES('${id(3)}','Reply','reply','contains','{"keywords":["información"]}','{"message":"Hola {{nombre}}"}','${id(1)}',true,1,NOW())`)
  m.send.mockReset().mockResolvedValue({status:'sent',wamid:'fake'});m.emit.mockClear()
 })
 afterAll(async()=>{await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()})
 it('deduplicates simultaneous webhook deliveries and keeps the inbound source line',async()=>{
  await Promise.all([evaluateAutomations(phone,'Más información','event-1',source),evaluateAutomations(phone,'Más información','event-1',source)])
  await processAutomationJobs();expect(m.send).toHaveBeenCalledTimes(1)
  expect(m.send).toHaveBeenCalledWith({request:{phoneNumberId:'phone-a',to:'+'+phone,type:'text',text:{body:'Hola Ana'}}})
  expect((await pool.query('SELECT result FROM automation_logs')).rows).toEqual([{result:'executed'}])
 })
 it('persists every flow step, waits and resumes it once across scheduler ticks',async()=>{
  await pool.query(`UPDATE automations SET type='flow',action_config='{"steps":[{"message":"one"},{"message":"two","delay_sec":60},{"message":"three"}]}'`)
  await evaluateAutomations(phone,'informacion','event-2',source);expect(m.send).toHaveBeenCalledTimes(1)
  await processAutomationJobs();expect(m.send).toHaveBeenCalledTimes(1)
  await pool.query("UPDATE automation_message_jobs SET run_at=NOW() WHERE status='queued'")
  await Promise.all([processAutomationJobs(),processAutomationJobs()]);await processAutomationJobs()
  expect(m.send.mock.calls.map(c=>c[0].request.text.body)).toEqual(['one','two','three'])
 })
 it('rechecks opt-out and rule pauses before delayed sends',async()=>{
  await pool.query(`UPDATE automations SET type='flow',action_config='{"steps":[{"message":"later","delay_sec":60}]}'`)
  await evaluateAutomations(phone,'informacion','event-3',source)
  await pool.query(`INSERT INTO blacklist VALUES('${phone}',NULL);UPDATE automation_message_jobs SET run_at=NOW()`)
  await processAutomationJobs();expect(m.send).not.toHaveBeenCalled()
  expect((await pool.query('SELECT status FROM automation_message_jobs')).rows[0].status).toBe('skipped')
 })
 it('does not retry an ambiguous provider result or later steps',async()=>{
  await pool.query(`UPDATE automations SET type='flow',action_config='{"steps":[{"message":"one"},{"message":"two"}]}'`)
  m.send.mockRejectedValue(Error('provider timeout'))
  await evaluateAutomations(phone,'informacion','event-4',source);await evaluateAutomations(phone,'informacion','event-4',source)
  expect(m.send).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT status FROM automation_message_jobs ORDER BY step')).rows.map(r=>r.status)).toEqual(['uncertain','skipped'])
 })
 it('blocks disabled creators and conversations already assigned to an operator',async()=>{
  await pool.query('UPDATE users SET is_active=false');await evaluateAutomations(phone,'informacion','event-5',source)
  await pool.query(`UPDATE users SET is_active=true;INSERT INTO conversation_state(phone_number,is_escalated) VALUES('${phone}',true)`)
  await evaluateAutomations(phone,'informacion','event-6',source);expect(m.send).not.toHaveBeenCalled()
 })
 it('marks handoff without requiring a message or provider request',async()=>{
  await pool.query(`UPDATE automations SET type='handoff',action_config='{}'`)
  await evaluateAutomations(phone,'informacion','event-7',source);expect(m.send).not.toHaveBeenCalled()
  expect((await pool.query('SELECT is_escalated FROM conversation_state')).rows[0].is_escalated).toBe(true)
 })
 it('routes Ofizeus More info to the exact variant once per inbound event',async()=>{
  await pool.query(`UPDATE contacts SET panel='ofizeus',linea=3,linea_sub='a';UPDATE automations SET trigger_type='keyword',trigger_config='{"keywords":["Más info"]}',action_config='{"message":"Hola {{nombre}}, esta es tu línea:","contact_line_directory":"ofizeus"}'`)
  await Promise.all([evaluateAutomations(phone,'Más info','routing-a',source),evaluateAutomations(phone,'Más info','routing-a',source)])
  expect(m.send).toHaveBeenCalledTimes(1)
  expect(m.send.mock.calls[0][0].request.text.body).toBe('Hola Ana, esta es tu línea:\n\nOFI 3A\n+5491124915455\nhttps://wa.me/5491124915455')
  expect(m.send.mock.calls[0][0].request.phoneNumberId).toBe('phone-a')
 })
 it('hands unknown variants to an advisor without substituting the primary line',async()=>{
  await pool.query(`UPDATE contacts SET panel='ofizeus',linea=3,linea_sub='b';UPDATE automations SET action_config='{"message":"Tu línea:","contact_line_directory":"ofizeus"}'`)
  await evaluateAutomations(phone,'información','routing-b',source)
  expect(m.send).toHaveBeenCalledTimes(1)
  expect(m.send.mock.calls[0][0].request.text.body).toContain('Un asesor te atenderá')
  expect(m.send.mock.calls[0][0].request.text.body).not.toContain('wa.me')
  expect((await pool.query('SELECT is_escalated FROM conversation_state')).rows[0].is_escalated).toBe(true)
 })
 it('responds to More info even when EXTRA just sent its separate reply',async()=>{
  await evaluateAutomations(phone,'información','extra-before-info',source)
  await pool.query(`UPDATE contacts SET panel='ofizeus',linea=3;INSERT INTO automations VALUES('${id(8)}','Routing','reply','keyword','{"keywords":["Mas info"]}','{"message":"Tu línea:","contact_line_directory":"ofizeus"}','${id(1)}',true,1,NOW())`)
  await evaluateAutomations(phone,'Más info','info-after-extra',source)
  expect(m.send).toHaveBeenCalledTimes(2)
  expect(m.send.mock.calls[1][0].request.text.body).toContain('https://wa.me/5491154726043')
 })
 it('does not send Ofizeus destinations to other agents',async()=>{
  await pool.query(`UPDATE contacts SET panel='royal',linea=3;UPDATE automations SET action_config='{"message":"Tu línea:","contact_line_directory":"ofizeus"}'`)
  await evaluateAutomations(phone,'información','routing-other',source)
  expect(m.send).not.toHaveBeenCalled()
 })
 it('validates step limits and accents in keyword matching',()=>{
  expect(automationMatches({trigger_type:'keyword',trigger_config:{keywords:['Información']}},'informacion')).toBe(true)
  expect(()=>automationSteps({type:'flow',action_config:{steps:[{message:'x',delay_sec:-1}]}})).toThrow()
  expect(()=>automationSteps({type:'reply',action_config:{message:''}})).toThrow()
 })

 const once=()=>pool.query(`UPDATE automations SET trigger_type='keyword',trigger_config='{"keywords":["EXTRA","Mas info"],"once_per_chat":true}'`)
 const ageJobs=()=>pool.query("UPDATE automation_message_jobs SET created_at=NOW()-interval '2 days'")
 it('sends one reply for EXTRA and Mas info together, including later days and edited text',async()=>{
  await once()
  await evaluateAutomations(phone,'EXTRA','first-extra',source)
  await evaluateAutomations(phone,'Más info','immediate-info',source)
  await ageJobs()
  await pool.query(`UPDATE automations SET action_config='{"message":"Texto editado"}'`)
  await evaluateAutomations(phone,'extra','later-extra',source)
  await processAutomationJobs()
  expect(m.send).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT count(*)::int AS count FROM automation_message_jobs')).rows[0].count).toBe(1)
  expect((await pool.query("SELECT count(*)::int AS count FROM automation_logs WHERE result='skipped'")).rows[0].count).toBe(2)
 })
 it('serializes distinct simultaneous inbound events across different lines for the same phone',async()=>{
  await once()
  await Promise.all([
   evaluateAutomations(phone,'EXTRA','event-a',source),
   evaluateAutomations('+'+phone,'Mas info','event-b',{provider:'cloud',phoneNumberId:'phone-b'}),
   evaluateAutomations(phone,'EXTRA','event-c',source),
  ])
  await processAutomationJobs();expect(m.send).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT count(*)::int AS count FROM automation_message_jobs')).rows[0].count).toBe(1)
 })
 it('recognizes replies already sent before enabling the option',async()=>{
  await evaluateAutomations(phone,'informacion','legacy-event',source)
  await ageJobs();await once()
  await evaluateAutomations(phone,'EXTRA','new-event',source)
  expect(m.send).toHaveBeenCalledTimes(1)
 })
 it('keeps the limit separate for each chat and each automation',async()=>{
  await once()
  await evaluateAutomations(phone,'EXTRA','chat-one',source)
  await evaluateAutomations('5491100000002','Mas info','chat-two',source)
  await ageJobs()
  await pool.query(`INSERT INTO automations VALUES('${id(4)}','Otra respuesta','reply','keyword','{"keywords":["ayuda"],"once_per_chat":true}','{"message":"Ayuda"}','${id(1)}',true,2,NOW())`)
  await evaluateAutomations(phone,'ayuda','different-rule',source)
  expect(m.send).toHaveBeenCalledTimes(3)
 })
 it('does not repeat an unconfirmed reply after another button press',async()=>{
  await once();m.send.mockRejectedValueOnce(Error('provider timeout'))
  await evaluateAutomations(phone,'EXTRA','timeout',source)
  await ageJobs()
  await evaluateAutomations(phone,'Mas info','after-timeout',source)
  expect(m.send).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT status FROM automation_message_jobs')).rows[0].status).toBe('uncertain')
 })
 it('allows a new inbound to retry when sending was skipped without contacting the provider',async()=>{
  await once();await pool.query('UPDATE whatsapp_lines SET sending_enabled=false')
  await evaluateAutomations(phone,'EXTRA','line-disabled',source)
  expect(m.send).not.toHaveBeenCalled()
  await pool.query('UPDATE whatsapp_lines SET sending_enabled=true')
  await evaluateAutomations(phone,'Mas info','line-restored',source)
  expect(m.send).toHaveBeenCalledTimes(1)
 })
 it('preserves repeat behavior when the option is explicitly disabled',async()=>{
  await once();await evaluateAutomations(phone,'EXTRA','first',source);await ageJobs()
  await pool.query(`UPDATE automations SET trigger_config=jsonb_set(trigger_config,'{once_per_chat}','false')`)
  await evaluateAutomations(phone,'Mas info','second',source)
  expect(m.send).toHaveBeenCalledTimes(2)
 })
 const queueLegacy=async(event:string,age:number)=>{
  await pool.query(`INSERT INTO automation_inbound_receipts(event_key,phone,provider,source_id) VALUES($1,$2,'cloud','phone-a')`,[event,phone])
  await pool.query(`INSERT INTO automation_message_jobs(event_key,automation_id,automation_name,phone,provider,source_id,body,step,run_at,created_at)
   VALUES($1,$2,'Reply',$3,'cloud','phone-a','Legacy reply',0,NOW(),NOW()-($4*interval '1 second'))`,[event,id(3),phone,age])
 }
 it('suppresses old queued duplicates after the option is enabled, even with concurrent processors',async()=>{
  await queueLegacy('older',120);await queueLegacy('newer',60);await once()
  await Promise.all([processAutomationJobs(),processAutomationJobs()]);await processAutomationJobs()
  expect(m.send).toHaveBeenCalledTimes(1)
  expect((await pool.query('SELECT event_key,status FROM automation_message_jobs ORDER BY created_at')).rows).toEqual([
   {event_key:'older',status:'sent'},{event_key:'newer',status:'skipped'},
  ])
 })
 it('skips a queued reply if this chat had already received the automation',async()=>{
  await evaluateAutomations(phone,'informacion','already-sent',source)
  await queueLegacy('pending-duplicate',0);await once();await processAutomationJobs()
  expect(m.send).toHaveBeenCalledTimes(1)
  expect((await pool.query("SELECT status FROM automation_message_jobs WHERE event_key='pending-duplicate'")).rows[0].status).toBe('skipped')
 })
})
