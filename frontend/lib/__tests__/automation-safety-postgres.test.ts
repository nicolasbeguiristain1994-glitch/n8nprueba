// @vitest-environment node
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool,type PoolClient } from 'pg'
const m=vi.hoisted(()=>({query:vi.fn(),tx:vi.fn(),identity:vi.fn()}))
vi.mock('@/lib/db',()=>({query:m.query,withTransaction:m.tx}))
vi.mock('@/lib/consent-context',()=>({resolveConsentIdentity:m.identity}))
import { automationAdmission,automationDispatchStillAllowed,automationFingerprints,automationScope,lockAutomationConversation,
  recordHumanAutomationIntervention,recordAutomationDispatchFinished,setAutomationHandoff,withAutomationSafety,type AutomationSafetyContext,type AutomationSafetyJob } from '@/lib/automation-safety'
const base:AutomationSafetyContext={phone:'5491100000001',provider:'cloud',source_id:'synthetic-cloud',agent_code:'royal'}
describe.skipIf(!process.env.OPS_TEST_DATABASE_URL && process.env.RUN_CAMPAIGN_PG_TESTS!=='1')('automation safety on local PostgreSQL, no external sends',()=>{
 let db:Pool,admin:Pool,activeTransactions=0
 const schema=`automation_safety_${randomUUID().replace(/-/g,'')}`
 beforeAll(async()=>{
  const url=new URL(process.env.OPS_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL??process.env.DATABASE_URL!)
  if(!['127.0.0.1','localhost'].includes(url.hostname)||url.search) throw Error('LOCAL_ONLY')
  admin=new Pool({connectionString:url.toString(),ssl:false});await admin.query(`CREATE SCHEMA ${schema}`)
  db=new Pool({connectionString:url.toString(),ssl:false,max:12,options:`-c search_path=${schema},public`})
  await db.query(`CREATE TABLE automation_conversation_safety(phone text,scope_key text,last_human_at timestamptz,last_automation_at timestamptz,
    handoff_event_key text,updated_at timestamptz DEFAULT now(),PRIMARY KEY(phone,scope_key));
   CREATE TABLE automation_inbound_receipts(event_key text PRIMARY KEY,phone text,provider text,source_id text,created_at timestamptz DEFAULT now());
   CREATE TABLE automation_message_jobs(id uuid PRIMARY KEY,event_key text,phone text,provider text,source_id text,agent_code text,body text,
    body_fingerprint text,link_fingerprints text[] NOT NULL DEFAULT '{}',status text DEFAULT 'queued',created_at timestamptz DEFAULT clock_timestamp(),
    started_at timestamptz,finished_at timestamptz,dispatch_authorized_at timestamptz,run_at timestamptz DEFAULT now(),details text);
   CREATE TABLE conversation_state(phone_number text,resolved_at timestamptz,is_escalated boolean);`)
  m.query.mockImplementation(async(sql,params)=>(await db.query(sql,params)).rows)
  m.tx.mockImplementation(async fn=>{const client=await db.connect();activeTransactions++;try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result}catch(e){await client.query('ROLLBACK');throw e}finally{activeTransactions--;client.release()}})
 })
 beforeEach(async()=>{await db.query('TRUNCATE automation_conversation_safety,automation_inbound_receipts,automation_message_jobs,conversation_state');m.identity.mockResolvedValue({agent:'royal'})})
 afterAll(async()=>{if(db)await db.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()}})
 async function job(body='Hola',over:Partial<AutomationSafetyContext>={},status='processing'):Promise<AutomationSafetyJob>{
  const context={...base,...over},id=randomUUID(),event=`event:${id}`,f=automationFingerprints(body)
  await db.query('INSERT INTO automation_inbound_receipts(event_key,phone,provider,source_id) VALUES($1,$2,$3,$4)',[event,context.phone,context.provider,context.source_id])
  await db.query(`INSERT INTO automation_message_jobs(id,event_key,phone,provider,source_id,agent_code,body,body_fingerprint,link_fingerprints,status,started_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10='processing' THEN clock_timestamp() END)`,
  [id,event,context.phone,context.provider,context.source_id,context.agent_code,body,f.body,f.links,status])
  return {...context,id,event_key:event,body}
 }
 const gap=()=>db.query("UPDATE automation_conversation_safety SET last_automation_at=clock_timestamp()-interval '11 seconds'")
 const finish=(j:AutomationSafetyJob)=>m.tx(async(client:PoolClient)=>{await lockAutomationConversation(client,j);await client.query("UPDATE automation_message_jobs SET status='sent',finished_at=clock_timestamp() WHERE id=$1",[j.id]);await recordAutomationDispatchFinished(client,j)})
 const admit=(body:string,context=base)=>m.tx(async(client:PoolClient)=>{await lockAutomationConversation(client,context);return automationAdmission(client,context,body)})
 it('canonicalizes bodies and tracking-only URL variations without merging distinct links',()=>{
  expect(automationFingerprints('  HOLA\nCliente ').body).toBe(automationFingerprints('hola cliente').body)
  expect(automationFingerprints('https://example.test/help/?utm_source=x#section').links).toEqual(automationFingerprints('https://example.test/help').links)
  expect(automationFingerprints('https://example.test/help?id=2').links).not.toEqual(automationFingerprints('https://example.test/help?id=1').links)
 })
 it('reserves at most3 pending replies across simultaneous inbound events and source lines',async()=>{
  const accepted=await Promise.all(Array.from({length:8},(_,n)=>m.tx(async(client:PoolClient)=>{
   const context={...base,source_id:n%2?'cloud-b':'cloud-a'};await lockAutomationConversation(client,context)
   if(await automationAdmission(client,context,`Respuesta ${n}`))return false
   await client.query(`INSERT INTO automation_message_jobs(id,phone,provider,source_id,agent_code,body,status) VALUES($1,$2,$3,$4,$5,$6,'queued')`,[randomUUID(),context.phone,context.provider,context.source_id,context.agent_code,`Respuesta ${n}`]);return true
  })))
  expect(accepted.filter(Boolean)).toHaveLength(3)
 })
 it('prevents a repeated body or link from another rule and recognizes legacy unhashed history',async()=>{
  await job('Primero https://example.test/help?utm_source=a',{},'sent')
  expect(await admit('Texto distinto https://example.test/help')).toContain('enlace')
  await db.query('UPDATE automation_message_jobs SET body_fingerprint=NULL')
  expect(await admit('primero https://example.test/help?utm_source=a')).toContain('mensaje')
 })
 it('keeps different businesses and unknown-source fallbacks separate',async()=>{
  await job('Hola',{},'sent');expect(await admit('Hola',{...base,agent_code:'nexus'})).toBeNull()
  await job('Anonimo',{agent_code:null,source_id:'a'},'sent')
  expect(await admit('Anonimo',{...base,agent_code:null,source_id:'b'})).toBeNull()
 })
 it('a new inbound cannot reset a rolling3-message limit and uncertain sends consume it',async()=>{
  for(let n=0;n<3;n++)await job(`Respuesta ${n}`,{},n===1?'uncertain':'sent')
  await db.query("UPDATE automation_message_jobs SET created_at=clock_timestamp()-interval '23 hours',started_at=NULL")
  expect(await admit('Nueva respuesta')).toContain('3 respuestas')
  await db.query("UPDATE automation_message_jobs SET created_at=clock_timestamp()-interval '25 hours'")
  expect(await admit('Nueva respuesta')).toBeNull()
 })
 it('does not hold a transaction while the provider callback runs',async()=>{
  const j=await job(),send=vi.fn(async()=>{expect(activeTransactions).toBe(0);expect(await automationDispatchStillAllowed(j)).toBe(true);return 'accepted'})
  expect(await withAutomationSafety(j,send)).toEqual({kind:'dispatched',value:'accepted'});expect(send).toHaveBeenCalledTimes(1)
 })
 it('enforces10 seconds even when all delayed steps become due together',async()=>{
  const first=await job('Uno');await withAutomationSafety(first,async()=>true);await finish(first)
  const second=await job('Dos'),send=vi.fn()
  expect(await withAutomationSafety(second,send)).toEqual({kind:'deferred'});expect(send).not.toHaveBeenCalled()
  expect((await db.query('SELECT status,dispatch_authorized_at,run_at>clock_timestamp() AS future FROM automation_message_jobs WHERE id=$1',[second.id])).rows[0])
   .toMatchObject({status:'queued',dispatch_authorized_at:null,future:true})
  await gap();await db.query("UPDATE automation_message_jobs SET status='processing',started_at=clock_timestamp() WHERE id=$1",[second.id])
  expect((await withAutomationSafety(second,async()=>true)).kind).toBe('dispatched')
 })

 it('keeps concurrent callbacks serialized even when provider preparation lasts longer than10s',async()=>{
  const first=await job('Uno'),second=await job('Dos')
  let started!:()=>void,release!:()=>void
  const running=new Promise<void>(r=>{started=r}),hold=new Promise<void>(r=>{release=r})
  const request=withAutomationSafety(first,async()=>{started();await hold;return true})
  await running;await gap()
  const sendSecond=vi.fn();expect(await withAutomationSafety(second,sendSecond)).toEqual({kind:'deferred'});expect(sendSecond).not.toHaveBeenCalled()
  release();await request;await finish(first)
  await db.query("UPDATE automation_message_jobs SET status='processing' WHERE id=$1",[second.id])
  expect(await withAutomationSafety(second,sendSecond)).toEqual({kind:'deferred'});expect(sendSecond).not.toHaveBeenCalled()
  await gap();await db.query("UPDATE automation_message_jobs SET status='processing' WHERE id=$1",[second.id])
  expect((await withAutomationSafety(second,async()=>true)).kind).toBe('dispatched')
 })
 it('a human cancels queued and claimed-but-not-authorized jobs including handoff notices',async()=>{
  await job('Pendiente',{},'queued');const claimed=await job('Tomado')
  await recordHumanAutomationIntervention(base.phone,{provider:'cloud',sourceId:base.source_id})
  expect((await db.query('SELECT DISTINCT status FROM automation_message_jobs')).rows).toEqual([{status:'skipped'}])
  const send=vi.fn();expect((await withAutomationSafety(claimed,send)).kind).toBe('skipped');expect(send).not.toHaveBeenCalled()
  expect(await admit('Más')).toContain('asesor')
 })
 it('human intervention on another business does not cancel this agent jobs',async()=>{
  await job('Royal',{},'queued');await job('Nexus',{agent_code:'nexus'},'queued')
  await recordHumanAutomationIntervention(base.phone,{provider:'cloud',sourceId:base.source_id})
  expect((await db.query('SELECT agent_code,status FROM automation_message_jobs ORDER BY agent_code')).rows).toEqual([
   {agent_code:'nexus',status:'queued'},{agent_code:'royal',status:'skipped'}])
 })
 it('records human intervention while an authorized request is in flight and blocks later steps',async()=>{
  const first=await job('Uno'),next=await job('Dos',{},'queued')
  let started!:()=>void,release!:()=>void
  const running=new Promise<void>(r=>{started=r}),hold=new Promise<void>(r=>{release=r})
  const request=withAutomationSafety(first,async()=>{started();await hold;return 'accepted'})
  await running;await recordHumanAutomationIntervention(base.phone,{provider:'cloud',sourceId:base.source_id})
  expect(await automationDispatchStillAllowed(first)).toBe(false)
  expect((await db.query('SELECT status FROM automation_message_jobs WHERE id=$1',[next.id])).rows[0].status).toBe('skipped')
  release();expect((await request).kind).toBe('dispatched')
 })
 it('only the own automatic handoff notice bypasses its escalation, never a human intervention',async()=>{
  const own=await job('Te atiende un asesor')
  await db.query('INSERT INTO conversation_state(phone_number,is_escalated) VALUES($1,true)',[base.phone])
  await m.tx(async(client:PoolClient)=>setAutomationHandoff(client,base,own.event_key))
  expect((await withAutomationSafety(own,async()=>true)).kind).toBe('dispatched');await finish(own);await gap()
  expect((await withAutomationSafety(await job('Otro aviso'),async()=>true)).kind).toBe('skipped')
  await recordHumanAutomationIntervention(base.phone,{provider:'cloud',sourceId:base.source_id});expect(await admit('Aviso nuevo')).toContain('asesor')
 })
 it('never revives an expired initiating session with a later inbound',async()=>{
  const expired=await job();await db.query("UPDATE automation_inbound_receipts SET created_at=clock_timestamp()-interval '25 hours' WHERE event_key=$1",[expired.event_key])
  await job('Evento reciente',{},'queued')
  const send=vi.fn();expect(await withAutomationSafety(expired,send)).toMatchObject({kind:'skipped',detail:expect.stringContaining('24 horas')})
  expect(send).not.toHaveBeenCalled()
 })
 it('does not extend a human session when an old webhook is retried',async()=>{
  await recordHumanAutomationIntervention(base.phone,{provider:'cloud',sourceId:base.source_id},new Date(Date.now()-25*3_600_000))
  expect(await admit('Hola')).toBeNull()
  const at=new Date(Date.now()-60_000)
  await recordHumanAutomationIntervention(base.phone,{provider:'cloud',sourceId:base.source_id},at)
  await recordHumanAutomationIntervention(base.phone,{provider:'cloud',sourceId:base.source_id},at)
  const row=(await db.query('SELECT last_human_at FROM automation_conversation_safety WHERE phone=$1 AND scope_key=$2',[base.phone,automationScope(base)])).rows[0]
  expect(new Date(row.last_human_at).toISOString()).toBe(at.toISOString())
 })
})
