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
describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS!=='1')('durable automations with simulated Cloud provider',()=>{
 let pool:Pool
 const schema=`automation_completion_${process.pid}`
 beforeAll(async()=>{
  const url=new URL(process.env.TEST_DATABASE_URL!);if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('LOCAL_ONLY')
  pool=new Pool({connectionString:url.toString(),ssl:false,max:5,options:`-c search_path=${schema}`})
  await pool.query(`CREATE SCHEMA ${schema};CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,role text);
   CREATE TABLE automations(id uuid PRIMARY KEY,name text,type text,trigger_type text,trigger_config jsonb,action_config jsonb,created_by uuid,is_active boolean,priority int,created_at timestamptz DEFAULT NOW());
   CREATE TABLE whatsapp_messages(id uuid PRIMARY KEY);
   CREATE TABLE automation_logs(automation_id uuid,automation_name text,conversation_phone text,message_id uuid,result text,details text);
   CREATE TABLE conversation_state(phone_number text,is_escalated boolean,escalated_at timestamptz,escalation_reason text,resolved_at timestamptz,updated_at timestamptz);
   CREATE UNIQUE INDEX active_conversation ON conversation_state(phone_number) WHERE resolved_at IS NULL;
   CREATE TABLE blacklist(phone_number_normalized text,removed_at timestamptz);
   CREATE TABLE contacts(phone_number text,first_name text,panel text);
   CREATE TABLE cloud_numbers(phone_number_id text,whatsapp_line_id uuid,status text);
   CREATE TABLE whatsapp_lines(id uuid,status text,is_connected boolean,sending_enabled boolean);
   INSERT INTO users VALUES('${id(1)}',true,'admin');INSERT INTO contacts VALUES('${phone}','Ana','Panel');
   INSERT INTO whatsapp_lines VALUES('${id(2)}','active',true,true);INSERT INTO cloud_numbers VALUES('phone-a','${id(2)}','active');`)
  await pool.query(readFileSync('../db/migrations/134_automation_delivery_jobs.sql','utf8'))
  m.query.mockImplementation(async(sql,params)=>(await pool.query(sql,params)).rows)
  m.tx.mockImplementation(async fn=>{const db=await pool.connect();try{await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r}catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}})
 })
 beforeEach(async()=>{
  await pool.query(`TRUNCATE automation_message_jobs,automation_inbound_receipts,automations,automation_logs,conversation_state,blacklist;UPDATE users SET is_active=true;UPDATE whatsapp_lines SET sending_enabled=true;
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
 it('validates step limits and accents in keyword matching',()=>{
  expect(automationMatches({trigger_type:'keyword',trigger_config:{keywords:['Información']}},'informacion')).toBe(true)
  expect(()=>automationSteps({type:'flow',action_config:{steps:[{message:'x',delay_sec:-1}]}})).toThrow()
  expect(()=>automationSteps({type:'reply',action_config:{message:''}})).toThrow()
 })
})
