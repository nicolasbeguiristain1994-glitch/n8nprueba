// @vitest-environment node
import {afterAll,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest'
import {Pool} from 'pg'
import {readFileSync} from 'node:fs'
import {OFIZEUS_LINES} from '@/lib/contact-line-directory'
const m=vi.hoisted(()=>({query:vi.fn(),tx:vi.fn(),send:vi.fn(),emit:vi.fn()}))
vi.mock('@/lib/db',()=>({query:m.query,withTransaction:m.tx}))
vi.mock('@/lib/cloud-api/use-cases/send-message.use-case',()=>({sendMessageUseCase:{execute:m.send}}))
vi.mock('@/lib/consent-context',()=>({resolveConsentIdentity:async(phone:string)=>{
 const rows=await m.query('SELECT DISTINCT lower(panel) AS agent FROM contacts WHERE phone_number IN($1,$2) AND deleted_at IS NULL',[phone,'+'+phone]);
 return {agent:rows.length===1?rows[0].agent:null,campaignId:null,sourceKey:null}
}}))
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
   CREATE TABLE blacklist(phone_number_normalized text,removed_at timestamptz,scope_key text DEFAULT 'global',agent_code text,source_key text);
   CREATE TABLE cloud_opt_outs(contact_phone text,opted_out bool,scope_key text,agent_code text);
   CREATE FUNCTION contact_agent_key(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT lower(trim(value)) $$;
   CREATE TABLE contacts(id uuid DEFAULT gen_random_uuid(),phone_number text,first_name text,panel text,linea int,linea_sub text,deleted_at timestamptz);
   CREATE TABLE agent_contact_lines(agent_code text,linea int,variant text,label text,phone text,is_active boolean DEFAULT true,link_url text);
   CREATE TABLE crm_agents(code text PRIMARY KEY,delivery_mode text DEFAULT 'phone'); INSERT INTO crm_agents(code) VALUES('royal'),('ofizeus');
   CREATE TABLE cloud_numbers(phone_number_id text,whatsapp_line_id uuid,status text);
   CREATE TABLE whatsapp_lines(id uuid,status text,is_connected boolean,sending_enabled boolean);
   INSERT INTO users VALUES('${id(1)}',true,'admin');INSERT INTO contacts(phone_number,first_name,panel) VALUES('${phone}','Ana','Panel');
   INSERT INTO whatsapp_lines VALUES('${id(2)}','active',true,true);INSERT INTO cloud_numbers VALUES('phone-a','${id(2)}','active'),('phone-b','${id(2)}','active');`)
  await pool.query(readFileSync('../db/migrations/134_automation_delivery_jobs.sql','utf8'))
  await pool.query('ALTER TABLE automation_message_jobs ADD COLUMN agent_code text')
  for (const [linea,variant,label,number] of OFIZEUS_LINES)
    await pool.query("INSERT INTO agent_contact_lines VALUES('ofizeus',$1,$2,$3,$4,true)",[linea,variant,label,'+'+number])
  m.query.mockImplementation(async(sql,params)=>(await pool.query(sql,params)).rows)
  m.tx.mockImplementation(async fn=>{const db=await pool.connect();try{await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r}catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}})
 })
 beforeEach(async()=>{
  await pool.query(`UPDATE crm_agents SET delivery_mode='phone';UPDATE agent_contact_lines SET link_url=NULL;TRUNCATE automation_message_jobs,automation_inbound_receipts,automations,automation_logs,conversation_state,blacklist;DELETE FROM agent_contact_lines WHERE agent_code='royal';UPDATE contacts SET panel='Panel',linea=NULL,linea_sub=NULL,deleted_at=NULL;UPDATE users SET is_active=true;UPDATE whatsapp_lines SET sending_enabled=true;
   INSERT INTO automations VALUES('${id(3)}','Reply','reply','contains','{"keywords":["información"]}','{"message":"Hola {{nombre}}"}','${id(1)}',true,1,NOW())`)
  m.send.mockReset().mockResolvedValue({status:'sent',wamid:'fake'});m.emit.mockClear()
  for (const [linea,variant,label,number] of OFIZEUS_LINES)
    await pool.query("UPDATE agent_contact_lines SET label=$3,phone=$4,is_active=true WHERE agent_code='ofizeus' AND linea=$1 AND variant=$2",[linea,variant,label,'+'+number])
 })
 afterAll(async()=>{await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()})
 it('routes the configured link through the real automation and fails closed if the link is missing',async()=>{
  await pool.query(`UPDATE contacts SET panel='ofizeus',linea=3,linea_sub='a';UPDATE automations SET action_config='{"message":"Tu línea: {{2}}","contact_line_directory":"ofizeus"}';
    UPDATE crm_agents SET delivery_mode='link' WHERE code='ofizeus';UPDATE agent_contact_lines SET link_url='https://example.com/zeus3' WHERE agent_code='ofizeus' AND linea=3 AND variant=''`)
  await evaluateAutomations(phone,'informacion','link-1',source)
  expect(m.send.mock.calls[0][0].request.text.body).toBe('Tu línea: https://example.com/zeus3')
  expect(m.send.mock.calls[0][0].request.text.body).not.toContain('549')
  await pool.query("DELETE FROM automation_message_jobs;UPDATE agent_contact_lines SET link_url=NULL")
  await evaluateAutomations(phone,'informacion','link-2',source)
  expect(m.send.mock.calls.at(-1)?.[0].request.text.body).toBe('Gracias por escribirnos. Un asesor te atenderá para indicarte tu línea correspondiente.')
 })
 it('deduplicates simultaneous webhook deliveries and keeps the inbound source line',async()=>{
  await Promise.all([evaluateAutomations(phone,'Más información','event-1',source),evaluateAutomations(phone,'Más información','event-1',source)])
  await processAutomationJobs();expect(m.send).toHaveBeenCalledTimes(1)
  expect(m.send).toHaveBeenCalledWith({request:{phoneNumberId:'phone-a',to:'+'+phone,agentCode:'panel',type:'text',text:{body:'Hola Ana'}}})
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
  await pool.query(`INSERT INTO blacklist(phone_number_normalized,removed_at) VALUES('${phone}',NULL);UPDATE automation_message_jobs SET run_at=NOW()`)
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
 it('uses edited destinations and hands off inactive lines without falling back to hardcoded numbers',async()=>{
  await pool.query(`UPDATE contacts SET panel='ofizeus',linea=3,linea_sub='a';UPDATE automations SET action_config='{"message":"Tu línea:","contact_line_directory":"ofizeus"}';
    UPDATE agent_contact_lines SET phone='+5491199999999',label='Nueva 3' WHERE linea=3 AND variant=''`)
  await evaluateAutomations(phone,'información','edited-destination',source)
  expect(m.send.mock.calls[0][0].request.text.body).toBe('Tu línea:\n\nNueva 3 549 | 1199 | 999999')
  await pool.query("UPDATE agent_contact_lines SET is_active=false WHERE linea=3 AND variant='';DELETE FROM automation_message_jobs")
  await evaluateAutomations(phone,'información','inactive-destination',source)
  expect(m.send.mock.calls[1][0].request.text.body).toContain('Un asesor te atenderá')
 })
 it('routes legacy Ofizeus variants to the base line once per inbound event',async()=>{
  await pool.query(`UPDATE contacts SET panel='ofizeus',linea=3,linea_sub='a';UPDATE automations SET trigger_type='keyword',trigger_config='{"keywords":["Más info"]}',action_config='{"message":"Hola {{nombre}}, esta es tu línea:","contact_line_directory":"ofizeus"}'`)
  await Promise.all([evaluateAutomations(phone,'Más info','routing-a',source),evaluateAutomations(phone,'Más info','routing-a',source)])
  expect(m.send).toHaveBeenCalledTimes(1)
  expect(m.send.mock.calls[0][0].request.text.body).toBe('Hola Ana, esta es tu línea:\n\nZEUS 3 549 | 1154 | 726043')
  expect(m.send.mock.calls[0][0].request.phoneNumberId).toBe('phone-a')
 })
 it('renders the number variable before persisting and sending the reply',async()=>{
  await pool.query(`UPDATE contacts SET panel='ofizeus',linea=3,linea_sub='a';UPDATE automations SET action_config='{"message":"Hola {{nombre}}!\\nLines designada: {{2}}","contact_line_directory":"ofizeus"}'`)
  await evaluateAutomations(phone,'información','variable-number',source)
  const expected='Hola Ana!\nLines designada: 549 | 1154 | 726043'
  expect(m.send.mock.calls[0][0].request.text.body).toBe(expected)
  expect((await pool.query('SELECT body FROM automation_message_jobs')).rows[0].body).toBe(expected)
 })
 it.each(['a','b','c'])('routes retired variant %s to the base line without handoff',async variant=>{
  await pool.query(`UPDATE contacts SET panel='ofizeus',linea=3,linea_sub='${variant}';UPDATE automations SET action_config='{"message":"Tu línea:","contact_line_directory":"ofizeus"}'`)
  await evaluateAutomations(phone,'información','routing-b',source)
  expect(m.send).toHaveBeenCalledTimes(1)
  expect(m.send.mock.calls[0][0].request.text.body).toBe('Tu línea:\n\nZEUS 3 549 | 1154 | 726043')
  expect((await pool.query('SELECT is_escalated FROM conversation_state WHERE is_escalated=true')).rows).toHaveLength(0)
 })
 it('responds to More info even when EXTRA just sent its separate reply',async()=>{
  await evaluateAutomations(phone,'información','extra-before-info',source)
  await pool.query(`UPDATE contacts SET panel='ofizeus',linea=3;INSERT INTO automations VALUES('${id(8)}','Routing','reply','keyword','{"keywords":["Mas info"]}','{"message":"Tu línea:","contact_line_directory":"ofizeus"}','${id(1)}',true,1,NOW())`)
  await evaluateAutomations(phone,'Más info','info-after-extra',source)
  expect(m.send).toHaveBeenCalledTimes(2)
  expect(m.send.mock.calls[1][0].request.text.body).toContain('ZEUS 3 549 | 1154 | 726043')
 })
 it('does not send Ofizeus destinations to other agents',async()=>{
  await pool.query(`UPDATE contacts SET panel='royal',linea=3;UPDATE automations SET action_config='{"message":"Tu línea:","contact_line_directory":"ofizeus"}'`)
  await evaluateAutomations(phone,'información','routing-other',source)
  expect(m.send).not.toHaveBeenCalled()
 })

 const royalRule=async(line=1,variant:string|null=null)=>{
  await pool.query("UPDATE contacts SET panel='royal',linea=$1,linea_sub=$2",[line,variant])
  await pool.query(`UPDATE automations SET trigger_type='keyword',trigger_config='{"keywords":["EXTRA","Mas info"],"once_per_chat":true}',action_config='{"message":"Ofizeus {{2}}","contact_line_directory":"ofizeus"}';
   INSERT INTO automations VALUES('${id(9)}','Royal','reply','keyword','{"keywords":["EXTRA","Mas info"],"once_per_chat":true}','{"message":"Tu línea: {{2}}","contact_line_directory":"royal"}','${id(1)}',true,1,NOW());
   INSERT INTO agent_contact_lines VALUES('royal',1,'','Royal 1','+5491100000001',true),('royal',1,'a','Royal 1A','+5491100000002',true)`)
 }
 it('selects Royal instead of the older Ofizeus rule, keeps the sender, and replies once across both keywords',async()=>{
  await royalRule()
  await Promise.all([evaluateAutomations(phone,'EXTRA','royal-first',source),evaluateAutomations(phone,'EXTRA','royal-first',source)])
  await evaluateAutomations(phone,'Más info','royal-second',source)
  expect(m.send).toHaveBeenCalledTimes(1)
  expect(m.send).toHaveBeenCalledWith({request:{phoneNumberId:'phone-a',to:'+'+phone,agentCode:'royal',type:'text',text:{body:'Tu línea: 549 | 1100 | 000001'}}})
  expect((await pool.query('SELECT automation_id FROM automation_message_jobs')).rows).toEqual([{automation_id:id(9)}])
 })
 it('reads the edited Royal base line for a legacy variant',async()=>{
  await royalRule(1,'a')
  await pool.query("UPDATE agent_contact_lines SET phone='+5491100000003' WHERE agent_code='royal' AND variant=''")
  await evaluateAutomations(phone,'EXTRA','royal-variant',source)
  expect(m.send.mock.calls[0][0].request.text.body).toBe('Tu línea: 549 | 1100 | 000003')
 })
 it.each(['missing','inactive'])('hands off %s Royal assignments without borrowing an Ofizeus or another Royal number',async kind=>{
  await royalRule(kind==='missing'?5:1,null)
  if(kind==='inactive')await pool.query("UPDATE agent_contact_lines SET is_active=false WHERE agent_code='royal'")
  await evaluateAutomations(phone,'EXTRA','royal-'+kind,source)
  expect(m.send).toHaveBeenCalledTimes(1)
  expect(m.send.mock.calls[0][0].request.text.body).toBe('Gracias por escribirnos. Un asesor te atenderá para indicarte tu línea correspondiente.')
  expect((await pool.query('SELECT is_escalated FROM conversation_state')).rows).toEqual([{is_escalated:true}])
 })
 it('ignores both directory rules for a different agent',async()=>{
  await royalRule();await pool.query("UPDATE contacts SET panel='other'")
  await evaluateAutomations(phone,'EXTRA','other-agent',source)
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
