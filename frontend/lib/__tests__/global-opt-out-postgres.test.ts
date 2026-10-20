// @vitest-environment node
import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest'
import {Pool} from 'pg'
import {NextRequest} from 'next/server'
import {readFileSync} from 'node:fs'
const m=vi.hoisted(()=>({query:vi.fn(),tx:vi.fn(),post:vi.fn(),token:vi.fn(),limit:vi.fn()}))
vi.mock('@/lib/permissions',()=>({checkPermissionWithUser:vi.fn().mockResolvedValue({ok:true,user:{user_id:'00000000-0000-4000-8000-000000000001',role:'admin'}})}))
vi.mock('@/lib/conversation-access',()=>({canReadConversation:vi.fn().mockResolvedValue(true),conversationPhone:(phone:string)=>phone.replace(/^\+/, '')}))
vi.mock('@/lib/sse-events',()=>({emitUpdate:vi.fn()}))
vi.mock('@/lib/audit',()=>({audit:vi.fn()}))
vi.mock('@/lib/db',()=>({query:m.query,withTransaction:m.tx}))
vi.mock('@/lib/campaign-risk',()=>({
 CampaignRiskError:class extends Error {status=409;code='CAMPAIGN_RISK_BLOCKED'},
 CAMPAIGN_RISK_CLEAR_SQL:'true /* campaign-risk-clear */',
 evaluateCampaignRisk:vi.fn().mockResolvedValue(undefined),assertCloudSendRiskClear:vi.fn(),recordCampaignProviderRisk:vi.fn(),
}))
vi.mock('@/lib/cloud-api/meta-risk-refresh',()=>({refreshCampaignMetaRisk:vi.fn()}))
vi.mock('@/lib/cloud-api/token-store',()=>({getTokenForNumber:m.token}))
vi.mock('@/lib/cloud-api/rate-limiter',()=>({enforceRateLimit:m.limit}))
vi.mock('@/lib/cloud-api/infrastructure/meta-http.gateway',()=>({MetaHttpGateway:class {post=m.post}}))
import {PATCH as reinstateFromConversation} from '@/app/api/conversations/[phone]/blacklist/route'
import {recordGlobalOptOut,reinstateGlobalContact,isGloballyOptedOut,withGlobalSendGuard} from '@/lib/global-opt-out'
import {resolveConsentIdentity} from '@/lib/consent-context'
import {recordHumanAutomationIntervention,automationAdmission,lockAutomationConversation} from '@/lib/automation-safety'
import {sendQueuedWithConsent} from '@/lib/cloud-api/queued-send-guard'
import {sendOptOutConfirmation} from '@/lib/opt-out-confirmation'
import {OptOutError} from '@/lib/cloud-api/errors'
import {contactAccountKey} from '@/lib/contact-account-identity'
const phone='5491100000001',id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const request={phone,sourceId:'line-1',provider:'cloud' as const,messageId:'baja-1',text:'BAJA',metadata:{input_type:'button',context_wamid:'bigwin-send'}}
describe.skipIf(!process.env.OPS_TEST_DATABASE_URL)('accounts and agent consent on PostgreSQL, no real provider',()=>{
 let pool:Pool
 const schema=`agent_consent_${process.pid}`
 let migrationFacts:Record<string,unknown>[]
 beforeAll(async()=>{
  const url=new URL(process.env.OPS_TEST_DATABASE_URL!)
  if(!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY')
  pool=new Pool({connectionString:url.toString(),ssl:false,max:6,options:`-c search_path=${schema}`})
  await pool.query(`CREATE SCHEMA ${schema};
   CREATE TABLE users(id uuid PRIMARY KEY,allowed_agents text[] DEFAULT '{}');
   CREATE TABLE campaigns(id uuid PRIMARY KEY,status text DEFAULT 'running');
   CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),external_id text UNIQUE,phone_number varchar(20),
    first_name text,last_name text,panel text,panels_assigned text[] DEFAULT '{}',casino_accounts jsonb DEFAULT '[]',
    status text DEFAULT 'active',opt_in_marketing bool DEFAULT true,opt_in_sms bool DEFAULT true,do_not_contact bool DEFAULT false,
    segmentation_profile jsonb,total_deposits int,total_withdrawals int,last_deposit_at timestamptz,segment text,segment_is_manual bool DEFAULT false,platform_source text,linea int,linea_sub text,platforms text[],deleted_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz);
   CREATE UNIQUE INDEX idx_contacts_phone_unique ON contacts(phone_number);
   CREATE TABLE whatsapp_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contact_id uuid,campaign_id uuid,campaign_recipient_id uuid,phone_number varchar(20),message_body text,direction text,status text,evolution_message_id varchar(255),sent_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz,metadata jsonb);
   CREATE TABLE campaign_recipients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),campaign_id uuid,contact_id uuid,phone_number text,status text DEFAULT 'pending',line_id uuid,locked_at timestamptz,error_detail text,updated_at timestamptz);
   CREATE TABLE automation_message_jobs(id uuid,phone text,status text,provider text,source_id text,finished_at timestamptz,details text,dispatch_authorized_at timestamptz);
   CREATE TABLE automation_conversation_safety(phone text,scope_key text,last_human_at timestamptz,last_automation_at timestamptz,handoff_event_key text,updated_at timestamptz DEFAULT now(),PRIMARY KEY(phone,scope_key));
   CREATE TABLE cloud_conversations(id uuid PRIMARY KEY,contact_phone text,phone_number_id text,window_expires_at timestamptz);
   CREATE TABLE cloud_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid,phone_number_id text,campaign_id uuid,direction text,message_type text,content jsonb,status text,wamid text,queued_at timestamptz,created_at timestamptz DEFAULT now(),sent_at timestamptz,failed_at timestamptz,error_code int,error_title text,error_details text);
   CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY,evolution_instance varchar(100),evolution_url text,line_type text,status text,is_connected bool,sending_enabled bool);
   CREATE TABLE cloud_numbers(phone_number_id text,whatsapp_line_id uuid,status text);
   CREATE TABLE operator_contact_visibility(operator_id uuid,contact_id uuid,assigned_by uuid,UNIQUE(operator_id,contact_id));
   CREATE TABLE contact_lists(id uuid PRIMARY KEY,filters jsonb,contact_count int);
   CREATE TABLE contact_tags(contact_id uuid,tag text);
   CREATE TABLE casino_segmentation_players(id uuid,username_lower text,platform text,agente text);
   CREATE TABLE contact_list_members(list_id uuid,contact_id uuid,UNIQUE(list_id,contact_id));
   INSERT INTO contacts(phone_number,first_name,panel,casino_accounts) VALUES('+${phone}','juan24z / juan244z','bigwin','[{"panel":"bigwin","username":"juan24z"},{"panel":"royal","username":"juan244z"}]');`)
  await pool.query(readFileSync('../db/migrations/041_blacklist.sql','utf8'))
  await pool.query(readFileSync('../db/migrations/069_cloud_api_opt_outs.sql','utf8'))
  await pool.query(readFileSync('../db/migrations/038_app_settings.sql','utf8'))
  await expect(pool.query(readFileSync('../db/migrations/154_contact_accounts_agent_consent.sql','utf8').replaceAll('public.',`${schema}.`))).rejects.toThrow('Activate the verified schema transition gate')
  await pool.query("INSERT INTO app_settings(key,value,type) VALUES('contact_schema_required_version','2','number')")
  await pool.query('BEGIN')
  await pool.query(readFileSync('../db/migrations/154_contact_accounts_agent_consent.sql','utf8').replaceAll('public.',`${schema}.`))
  await pool.query('COMMIT')
  migrationFacts=(await pool.query('SELECT first_name,panel,phone_number,identity_key FROM contacts ORDER BY panel')).rows
  m.query.mockImplementation(async(sql,params)=>(await pool.query(sql,params)).rows)
  m.tx.mockImplementation(async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}})
 })
 beforeEach(async()=>{
  m.post.mockReset();m.post.mockResolvedValue({messages:[{id:'confirmation-id'}]});m.token.mockResolvedValue('test-only');m.limit.mockResolvedValue(undefined)
  await pool.query(`TRUNCATE automation_conversation_safety,contacts,blacklist,cloud_opt_outs,cloud_consent_log,whatsapp_messages,campaign_recipients,automation_message_jobs,cloud_messages,cloud_conversations,users,campaigns,whatsapp_lines,cloud_numbers CASCADE;
   INSERT INTO users(id) VALUES('${id(1)}'); INSERT INTO campaigns(id) VALUES('${id(20)}'),('${id(21)}');
   INSERT INTO contacts(id,phone_number,first_name,panel,casino_accounts,account_username,identity_key) VALUES
    ('${id(2)}','+${phone}','juan24z','bigwin','[{"panel":"bigwin","username":"juan24z"}]','juan24z','["bigwin", "juan24z"]'),
    ('${id(3)}','+${phone}','juan244z','royal','[{"panel":"royal","username":"juan244z"}]','juan244z','["royal", "juan244z"]');
   INSERT INTO whatsapp_lines VALUES('${id(8)}',NULL,NULL,'cloud','active',true,true),('${id(9)}',NULL,NULL,'cloud','active',true,true);
   INSERT INTO cloud_numbers VALUES('line-1','${id(8)}','active'),('line-2','${id(9)}','active');
   INSERT INTO campaign_recipients(id,campaign_id,contact_id,phone_number,status,line_id,agent_code) VALUES
    ('${id(30)}','${id(20)}','${id(2)}','+${phone}','pending','${id(8)}','bigwin'),
    ('${id(31)}','${id(21)}','${id(3)}','+${phone}','pending','${id(9)}','royal');
   INSERT INTO whatsapp_messages(contact_id,campaign_id,campaign_recipient_id,phone_number,direction,status,evolution_message_id,created_at,metadata) VALUES
    ('${id(2)}','${id(20)}','${id(30)}','+${phone}','outbound','sent','bigwin-send',now()-interval '2 hours','{"line_id":"${id(8)}","agent_code":"bigwin"}'),
    ('${id(3)}','${id(21)}','${id(31)}','+${phone}','outbound','sent','royal-send',now()-interval '1 hour','{"line_id":"${id(9)}","agent_code":"royal"}');
   INSERT INTO cloud_conversations VALUES('${id(40)}','+${phone}','line-1',now()+interval '24 hours'),('${id(41)}','+${phone}','line-2',now()+interval '24 hours');
   INSERT INTO cloud_messages(id,conversation_id,phone_number_id,campaign_id,direction,message_type,content,status) VALUES
    ('${id(50)}','${id(40)}','line-1','${id(20)}','outbound','text','{"agentCode":"bigwin"}','queued'),
    ('${id(51)}','${id(41)}','line-2','${id(21)}','outbound','text','{"agentCode":"royal"}','queued');
   INSERT INTO cloud_messages(conversation_id,phone_number_id,direction,message_type,content,status,wamid,sent_at)
    VALUES('${id(40)}','line-1','inbound','text','{}','delivered','baja-1',now());
   INSERT INTO automation_message_jobs(id,phone,status,provider,source_id,agent_code) VALUES
    ('${id(60)}','${phone}','queued','cloud','line-1','bigwin'),('${id(61)}','${phone}','queued','cloud','line-2','royal');`)
 })
 afterAll(async()=>{if(pool){await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()}})

 it.each(['cloud','evolution'] as const)('keeps the Royal human hold across a persisted %s manual reply and a new inbound',async provider=>{
  if(provider==='evolution')await pool.query("UPDATE whatsapp_lines SET line_type='evolution',evolution_instance='royal-instance' WHERE id=$1",[id(9)])
  const sourceId=provider==='cloud'?'line-2':'royal-instance'
  const source={provider,sourceId}
  expect((await resolveConsentIdentity(phone,source)).agent).toBe('royal')
  const agent=await recordHumanAutomationIntervention(phone,source)
  expect(agent).toBe('royal')
  if(provider==='cloud') {
   await pool.query(`INSERT INTO cloud_messages(conversation_id,phone_number_id,direction,message_type,content,status,wamid,sent_at)
    VALUES($1,'line-2','outbound','text',$2::jsonb,'sent','manual-royal',clock_timestamp())`,[id(41),JSON.stringify({agentCode:agent,text:{body:'Respuesta humana sintética'}})])
   await pool.query(`INSERT INTO cloud_messages(conversation_id,phone_number_id,direction,message_type,content,status,wamid,sent_at)
    VALUES($1,'line-2','inbound','text','{}','delivered','new-inbound',clock_timestamp())`,[id(41)])
  } else {
   await pool.query(`INSERT INTO whatsapp_messages(phone_number,message_body,direction,status,evolution_message_id,sent_at,metadata)
    VALUES($1,'Respuesta humana sintética','outbound','sent','manual-royal',clock_timestamp(),$2::jsonb)`,['+'+phone,JSON.stringify({line_id:id(9),agent_code:agent})])
   await pool.query(`INSERT INTO whatsapp_messages(phone_number,direction,status,evolution_message_id,created_at,metadata)
    VALUES($1,'inbound','received','new-inbound',clock_timestamp(),$2::jsonb)`,['+'+phone,JSON.stringify({line_id:id(9)})])
  }
  const inbound=await resolveConsentIdentity(phone,{...source,messageId:'new-inbound'})
  expect(inbound.agent).toBe('royal')
  const context={phone,provider,source_id:sourceId,agent_code:inbound.agent}
  const blocked=await m.tx(async(db:import('pg').PoolClient)=>{await lockAutomationConversation(db,context);return automationAdmission(db,context,'No debe enviarse')})
  expect(blocked).toContain('asesor')
  expect(m.post).not.toHaveBeenCalled()
 })
 it('splits the example into separate account rows with the same phone',()=>{
  expect(migrationFacts.map(r=>[r.first_name,r.panel,r.phone_number])).toEqual([['juan24z','bigwin','+'+phone],['juan244z','royal','+'+phone]])
  expect(migrationFacts[0].identity_key).toBe(contactAccountKey('bigwin','juan24z','+'+phone))
 })
 it('keeps namesakes in Bigwin and Imperio separate in account history',async()=>{
  await pool.query(`INSERT INTO casino_segmentation_players VALUES
   ('${id(90)}','shareduser','zeus','bigwin'),('${id(91)}','shareduser','ganamos','adminimperio');
   UPDATE contacts SET casino_accounts='[{"panel":"bigwin","username":"shareduser"}]' WHERE id='${id(2)}';
   UPDATE contacts SET casino_accounts='[{"panel":"adminimperio","username":"shareduser"}]' WHERE id='${id(3)}';`)
  const links=async()=>(await pool.query('SELECT contact_id,player_id FROM casino_contact_account_links ORDER BY contact_id')).rows
  expect(await links()).toEqual([{contact_id:id(2),player_id:id(90)},{contact_id:id(3),player_id:id(91)}])
  await pool.query(`UPDATE contacts SET casino_accounts='[{"panel":"bigwin","username":"shareduser","platform":"ganamos"}]' WHERE id='${id(2)}'`)
  expect(await links()).toEqual([{contact_id:id(3),player_id:id(91)}])
  await pool.query('DELETE FROM casino_segmentation_players')
 })
 it('records BAJA once under concurrent webhook retries, cancels only that agent',async()=>{
  await Promise.all([recordGlobalOptOut(request),recordGlobalOptOut(request)])
  const rows=(await pool.query('SELECT agent_code,scope_key FROM blacklist')).rows
  expect(rows).toEqual([{agent_code:'bigwin',scope_key:'agent:bigwin'}])
  expect((await pool.query('SELECT count(*)::int n FROM cloud_consent_log')).rows[0].n).toBe(1)
  expect((await pool.query('SELECT status FROM campaign_recipients ORDER BY id')).rows).toEqual([{status:'skipped'},{status:'pending'}])
  expect((await pool.query('SELECT status FROM automation_message_jobs ORDER BY id')).rows).toEqual([{status:'skipped'},{status:'queued'}])
  expect((await pool.query("SELECT status FROM cloud_messages WHERE direction='outbound' ORDER BY id")).rows).toEqual([{status:'failed'},{status:'queued'}])
 })
 it('does not attribute a newer unclassified reply to an older campaign',async()=>{
  await pool.query(`INSERT INTO whatsapp_messages(phone_number,direction,status,evolution_message_id,created_at,metadata)
    VALUES($1,'outbound','sent','manual-unknown',now()-interval '1 second',$2)`,['+'+phone,JSON.stringify({line_id:id(8)})])
  expect(await resolveConsentIdentity(phone,{provider:'cloud',sourceId:'line-1'})).toMatchObject({agent:null})
 })
 it('does not bypass an agent opt-out when the sender has no attributable account',async()=>{
  await recordGlobalOptOut(request)
  const send=vi.fn()
  await expect(withGlobalSendGuard(phone,send)).rejects.toBeInstanceOf(OptOutError)
  expect(send).not.toHaveBeenCalled()
 })
 it('blocks Bigwin on all sending lines while Royal remains allowed',async()=>{
  await recordGlobalOptOut(request)
  const send=vi.fn().mockResolvedValue('accepted')
  for(const sourceId of ['line-1','line-2','future-line']) {
   await expect(withGlobalSendGuard(phone,send,{provider:'cloud',sourceId,campaignId:id(20)})).rejects.toBeInstanceOf(OptOutError)
   expect(await withGlobalSendGuard(phone,send,{provider:'cloud',sourceId,campaignId:id(21)})).toBe('accepted')
  }
  expect(send).toHaveBeenCalledTimes(3)
 })
 it('resolves consent across production varchar and Cloud text phone columns',async()=>{
  expect(await resolveConsentIdentity(phone,{contactId:id(2)})).toMatchObject({agent:'bigwin'})
  expect(await resolveConsentIdentity(phone,{provider:'cloud',sourceId:'line-1',messageId:'baja-1'})).toMatchObject({agent:'bigwin'})
  expect(await resolveConsentIdentity(phone,{campaignId:id(21)})).toMatchObject({agent:'royal'})
  expect(await resolveConsentIdentity(phone,{})).toMatchObject({agent:null})
  expect(await isGloballyOptedOut(phone,{provider:'cloud',sourceId:'line-1',messageId:'baja-1'})).toBe(false)
 })
 it('uses the quoted campaign even when another agent sent more recently',async()=>{
  expect(await resolveConsentIdentity(phone,{provider:'cloud',sourceId:'line-1',contextWamid:'bigwin-send'})).toMatchObject({agent:'bigwin',campaignId:id(20)})
  expect(await resolveConsentIdentity(phone,{provider:'cloud',sourceId:'line-2'})).toMatchObject({agent:'royal'})
 })
 it('does not guess another agent when a quoted message cannot be attributed',async()=>{
  await recordGlobalOptOut({...request,metadata:{context_wamid:'missing'}})
  expect((await pool.query('SELECT agent_code,scope_key FROM blacklist')).rows).toEqual([{agent_code:null,scope_key:'source:cloud:line-1'}])
  expect(await isGloballyOptedOut(phone,{provider:'cloud',sourceId:'line-2',agentCode:'royal'})).toBe(false)
 })
 it('independent opt-outs and reactivation do not alter the other agent',async()=>{
  await recordGlobalOptOut(request)
  await recordGlobalOptOut({...request,sourceId:'line-2',messageId:'baja-2',metadata:{context_wamid:'royal-send'}})
  const [entry]=(await pool.query("SELECT id FROM blacklist WHERE agent_code='bigwin'")).rows
  await expect(reinstateGlobalContact(entry.id,id(1),'')).rejects.toThrow('consentimiento')
  expect(await reinstateGlobalContact(entry.id,id(1),'Confirmó por WhatsApp su nuevo consentimiento')).toBe(true)
  expect(await isGloballyOptedOut(phone,{agentCode:'bigwin'})).toBe(false)
  expect(await isGloballyOptedOut(phone,{agentCode:'royal'})).toBe(true)
  await recordGlobalOptOut(request)
  expect(await isGloballyOptedOut(phone,{agentCode:'bigwin'})).toBe(false)
 })
 it('conversation button removes only Royal, records the operator and never revives cancelled work',async()=>{
  await recordGlobalOptOut(request)
  await recordGlobalOptOut({...request,sourceId:'line-2',messageId:'baja-2',metadata:{context_wamid:'royal-send'}})
  const response=await reinstateFromConversation(new NextRequest('http://localhost/api/conversations/'+phone+'/blacklist',{
   method:'PATCH',body:JSON.stringify({agent_code:'royal',consent_confirmed:true,consent_note:'Confirmó por WhatsApp que tocó BAJA por error'})
  }),{params:Promise.resolve({phone})})
  expect(response.status).toBe(200)
  expect(await isGloballyOptedOut(phone,{agentCode:'royal'})).toBe(false)
  expect(await isGloballyOptedOut(phone,{agentCode:'bigwin'})).toBe(true)
  expect((await pool.query('SELECT agent_code,removed_by FROM blacklist WHERE removed_at IS NOT NULL')).rows).toEqual([{agent_code:'royal',removed_by:id(1)}])
  expect((await pool.query("SELECT agent_user_id,metadata->>'agent_code' agent FROM cloud_consent_log WHERE event='reinstated'")).rows).toEqual([{agent_user_id:id(1),agent:'royal'}])
  expect((await pool.query('SELECT DISTINCT status FROM campaign_recipients')).rows).toEqual([{status:'skipped'}])
  expect((await pool.query('SELECT DISTINCT status FROM automation_message_jobs')).rows).toEqual([{status:'skipped'}])
  expect((await pool.query("SELECT DISTINCT status FROM cloud_messages WHERE direction='outbound'")).rows).toEqual([{status:'failed'}])
  expect(m.post).not.toHaveBeenCalled()
 })
 it('cancelled queued work cannot resume after reinstatement; other agent can send',async()=>{
  await recordGlobalOptOut(request)
  const [entry]=(await pool.query('SELECT id FROM blacklist')).rows
  await reinstateGlobalContact(entry.id,id(1),'Nuevo consentimiento confirmado por WhatsApp')
  const send=vi.fn().mockResolvedValue('accepted')
  expect(await sendQueuedWithConsent(id(50),phone,send)).toBeNull()
  expect(await sendQueuedWithConsent(id(51),phone,send)).toBe('accepted')
  expect(send).toHaveBeenCalledTimes(1)
 })
 it('retains explicit global manual blocks',async()=>{
  await pool.query(`INSERT INTO blacklist(phone_number_raw,phone_number_normalized,source) VALUES($1,$2,'manual')`,['+'+phone,phone])
  expect(await isGloballyOptedOut(phone,{agentCode:'bigwin'})).toBe(true)
  expect(await isGloballyOptedOut(phone,{agentCode:'royal'})).toBe(true)
 })
 it('serializes BAJA and provider submission without sending to the other agent twice',async()=>{
  let release!:()=>void,entered!:()=>void
  const started=new Promise<void>(resolve=>entered=resolve)
  const sending=withGlobalSendGuard(phone,async()=>{entered();await new Promise<void>(resolve=>release=resolve);return 'accepted'},{agentCode:'bigwin'})
  await started
  const baja=recordGlobalOptOut(request);release();await sending;await baja
  await expect(withGlobalSendGuard(phone,vi.fn(),{agentCode:'bigwin'})).rejects.toBeInstanceOf(OptOutError)
 })
 it('sends at most one confirmation and never replays it after reactivation',async()=>{
  await recordGlobalOptOut({...request,confirmation:true})
  const confirmation={phone,sourceId:'line-1',messageId:'baja-1',provider:'cloud' as const}
  await Promise.all([sendOptOutConfirmation(confirmation),sendOptOutConfirmation(confirmation)])
  expect(m.post).toHaveBeenCalledTimes(1)
  const [entry]=(await pool.query('SELECT id FROM blacklist')).rows
  await reinstateGlobalContact(entry.id,id(1),'Confirmó nuevo consentimiento con el operador')
  await sendOptOutConfirmation(confirmation)
  expect(m.post).toHaveBeenCalledTimes(1)
 })
 it('preserves both accounts when consent is recorded or imports update a phone',async()=>{
  await recordGlobalOptOut(request)
  await pool.query('UPDATE contacts SET opt_in_marketing=true')
  expect((await pool.query('SELECT count(*)::int n FROM contacts')).rows[0].n).toBe(2)
  expect(await isGloballyOptedOut(phone,{agentCode:'bigwin'})).toBe(true)
  expect(await isGloballyOptedOut(phone,{agentCode:'royal'})).toBe(false)
 })
 it('prevents duplicate recipients for the same phone in one campaign',async()=>{
  await expect(pool.query(`INSERT INTO campaign_recipients(campaign_id,contact_id,phone_number,agent_code) VALUES($1,$2,$3,'royal')`,[id(20),id(3),phone])).rejects.toMatchObject({code:'23505'})
 })
})
