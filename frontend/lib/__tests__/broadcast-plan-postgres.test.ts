/** @vitest-environment node */
import { beforeAll,afterAll,beforeEach,describe,it,expect,vi } from 'vitest'
import { Pool } from 'pg'
import { getLineVolumeInputs } from '@/lib/line-volume-data'
import { withTransaction } from '@/lib/db'
import { getBroadcastPlanningOptions,prepareDailyBroadcast } from '@/lib/broadcast-plan-repository'
import { INACTIVITY_WINDOWS,RECONTACT_COOLDOWN_DAYS,VALUE_SCORES } from '@/lib/user-prioritization/config'
import type { SessionUser } from '@/lib/auth'

vi.mock('@/lib/line-volume-data',()=>({getLineVolumeInputs:vi.fn()}))
vi.mock('@/lib/db',()=>({withTransaction:vi.fn(),query:vi.fn()}))
vi.mock('@/lib/scoring-config-service',()=>({getAll:async()=>({allow_threshold:30,delay_threshold:60,cooldown_multiplier:2,risk_weight_daily:40,risk_weight_weekly:35,risk_weight_cooldown:25})}))
vi.mock('@/lib/segmentation-config-service',()=>({getAllTiers:async()=>Object.entries(INACTIVITY_WINDOWS).map(([tier,window])=>({tier,min_days_inactive:window.minDays,max_days_inactive:window.maxDays,value_score:VALUE_SCORES[tier as keyof typeof VALUE_SCORES],deposit_threshold_min:0,recontact_cooldown_days:RECONTACT_COOLDOWN_DAYS[tier as keyof typeof RECONTACT_COOLDOWN_DAYS]}))}))

const id=(n:number)=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`
const owner=id(1),other=id(2),a=id(11),b=id(12),cloud=id(13),run=id(50),campaign=id(70)
const user={user_id:owner,role:'operator',allowed_agents:['royal']} as SessionUser
const options={lineIds:[a,b],messageType:'text' as const,endTime:'23:59',reservePercent:10,maxContacts:500}

describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS!=='1')('daily broadcast preview on PostgreSQL',()=>{
  let pool:Pool
  const schema=`broadcast_plan_${process.pid}`
  beforeAll(async()=>{
    const url=new URL(process.env.DATABASE_URL!)
    if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    pool=new Pool({connectionString:url.toString(),options:`-c search_path=${schema},public`})
    await pool.query(`CREATE SCHEMA ${schema}`)
    await pool.query(`
      CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY,owner_user_id uuid,line_key text,display_name text,line_type text DEFAULT 'evolution',status text DEFAULT 'active',is_connected bool DEFAULT true,sending_enabled bool DEFAULT true,allowed_types jsonb,msg_per_day int DEFAULT 100,msg_per_hour int DEFAULT 100,msgs_sent_today int DEFAULT 0,msgs_sent_hour int DEFAULT 0,day_reset_at timestamptz,hour_reset_at timestamptz,priority int DEFAULT 1,personality_config jsonb);
      CREATE FUNCTION get_accessible_line_ids(actor uuid) RETURNS TABLE(id uuid) LANGUAGE sql AS $$ SELECT id FROM whatsapp_lines WHERE owner_user_id=actor $$;
      CREATE TABLE cloud_numbers(id uuid DEFAULT gen_random_uuid(),whatsapp_line_id uuid,status text DEFAULT 'active',waba_id text,phone_number_id text,access_token text,access_token_enc bytea,token_expires_at timestamptz);
      CREATE TABLE cloud_conversations(id uuid,contact_phone text);
      CREATE TABLE cloud_messages(conversation_id uuid,phone_number_id text,direction text,status text,sent_at timestamptz,created_at timestamptz);
      CREATE TABLE whatsapp_templates(id uuid,name text,waba_id text,status text,whatsapp_template_id text);
      CREATE TABLE contacts(id uuid PRIMARY KEY,first_name text,last_name text,phone_number text,status text DEFAULT 'active',opt_in_marketing bool DEFAULT true,do_not_contact bool DEFAULT false,deleted_at timestamptz,segment text DEFAULT 'vip',segment_is_manual bool DEFAULT false,segmentation_profile jsonb,last_deposit_at timestamptz DEFAULT NOW()-interval '40 days',panel text DEFAULT 'royal',platforms text[] DEFAULT ARRAY['zeus']);
      CREATE TABLE contact_priority_scores(contact_id uuid,run_id uuid,is_eligible bool DEFAULT true,is_broadcasted bool DEFAULT false,priority_score numeric DEFAULT 90,reactivation_segment text DEFAULT 'REACTIVACION_PRIORITARIA',value_tier text DEFAULT 'vip',computed_at timestamptz DEFAULT NOW());
      CREATE TABLE system_jobs(job_name text,last_complete_run_id uuid,last_success_at timestamptz,is_running bool DEFAULT false);
      CREATE TABLE operator_contact_visibility(operator_id uuid,contact_id uuid);
      CREATE TABLE blacklist(phone_number_normalized text,removed_at timestamptz,scope_key text DEFAULT 'global',agent_code text);
      CREATE FUNCTION contact_agent_key(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$;
      CREATE FUNCTION casino_monthly_value_tier(numeric) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'vip'::text $$;
      CREATE TABLE campaigns(id uuid PRIMARY KEY,owned_by uuid,status text DEFAULT 'running',scheduled_at timestamptz);
      CREATE TABLE campaign_recipients(id uuid DEFAULT gen_random_uuid(),campaign_id uuid,contact_id uuid,phone_number text,line_id uuid,status text DEFAULT 'pending',sent_at timestamptz,updated_at timestamptz DEFAULT NOW(),error_detail text);
      CREATE TABLE campaign_line_assignments(owner_key uuid,phone text,line_id uuid);
      CREATE TABLE phone_line_assignments(phone text,line_id uuid,updated_at timestamptz DEFAULT NOW());
      CREATE TABLE contact_send_history(contact_id uuid,sent_at timestamptz,campaign_recipient_id uuid,frequency_released_at timestamptz);
      CREATE TABLE whatsapp_messages(id uuid,campaign_recipient_id uuid,direction text,status text,error_detail text,updated_at timestamptz);
      CREATE TABLE contact_frequency_rules(id uuid,operator_id uuid,seg_monto text,seg_actividad text,max_per_day int,max_per_week int,min_hours_between_sends int,is_active bool,created_at timestamptz,updated_at timestamptz);
    `)
    vi.mocked(withTransaction).mockImplementation(async work=>{
      const client=await pool.connect()
      try {await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result}
      catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
    })
  })
  afterAll(async()=>{if(pool){await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()}})
  beforeEach(async()=>{
    vi.mocked(getLineVolumeInputs).mockImplementation(async ids => (ids ?? []).map(id => ({id,lineType:'evolution',status:'active',isConnected:true,sendingEnabled:true,campaignsAllowed:true,dailyLimit:100,hourlyLimit:100,dailyUsed:0,hourlyUsed:0,cloudStatus:null,quality:null,lastMetaCheckAt:null,activeRiskReasons:[],recentDays:[],now:new Date().toISOString()})))
    await pool.query(`TRUNCATE whatsapp_lines,cloud_numbers,cloud_conversations,cloud_messages,whatsapp_templates,contacts,contact_priority_scores,system_jobs,operator_contact_visibility,blacklist,campaigns,campaign_recipients,campaign_line_assignments,phone_line_assignments,contact_send_history,whatsapp_messages,contact_frequency_rules`)
    await pool.query(`INSERT INTO whatsapp_lines(id,owner_user_id,display_name) VALUES($1,$3,'A'),($2,$3,'B');`,[a,b,owner])
    await pool.query(`INSERT INTO whatsapp_lines(id,owner_user_id,display_name) VALUES($1,$2,'Privada')`,[id(14),other])
    await pool.query(`INSERT INTO system_jobs VALUES('prioritization_recompute',$1,NOW(),false)`,[run])
    await pool.query(`INSERT INTO contacts(id,first_name,phone_number) VALUES($1,'Uno','+54 911 00000001'),($2,'Dos','5491100000002')`,[id(21),id(22)])
    await pool.query(`INSERT INTO contact_priority_scores(contact_id,run_id) SELECT id,$1 FROM contacts`,[run])
  })
  it('returns only accessible lines and plans the full audience without writing assignments or counters',async()=>{
    expect((await getBroadcastPlanningOptions(user)).lines.map(l=>l.id)).toEqual([a,b])
    const first=await prepareDailyBroadcast(user,options),second=await prepareDailyBroadcast(user,options)
    expect(first.selected).toBe(2)
    expect(first.contacts).toEqual(second.contacts)
    expect((await pool.query('SELECT count(*)::int n FROM campaign_line_assignments')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT sum(msgs_sent_today)::int n FROM whatsapp_lines')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM campaign_recipients')).rows[0].n).toBe(0)
  })
  it('rejects a foreign line and scopes contacts by explicit visibility and agent',async()=>{
    await expect(prepareDailyBroadcast(user,{...options,lineIds:[id(14)]})).rejects.toMatchObject({status:403})
    await pool.query('INSERT INTO operator_contact_visibility VALUES($1,$2)',[owner,id(21)])
    expect((await prepareDailyBroadcast(user,options)).contacts.map(c=>c.id)).toEqual([id(21)])
    expect((await prepareDailyBroadcast(user,{...options,agent:'bigwin'})).total).toBe(0)
    expect((await prepareDailyBroadcast(user,{...options,platform:'bet30'})).total).toBe(0)
  })
  it('uses the last complete run and blocks preparation before the first run',async()=>{
    await pool.query('UPDATE contact_priority_scores SET run_id=$1 WHERE contact_id=$2',[id(51),id(22)])
    expect((await prepareDailyBroadcast(user,options)).total).toBe(1)
    await pool.query('UPDATE system_jobs SET last_complete_run_id=NULL')
    await expect(prepareDailyBroadcast(user,options)).rejects.toMatchObject({status:409})
  })
  it('deducts shared line commitments and excludes normalized phones queued elsewhere',async()=>{
    await pool.query('INSERT INTO campaigns(id,owned_by) VALUES($1,$2)',[campaign,other])
    await pool.query(`INSERT INTO campaign_recipients(campaign_id,phone_number,line_id) VALUES($1,'5491100000001',$2),($1,'5491199999999',$2)`,[campaign,a])
    const result=await prepareDailyBroadcast(user,options)
    expect(result.lines.find(l=>l.id===a)?.committed).toBe(2)
    expect(result.contacts.find(c=>c.id===id(21))?.reason).toBe('already_queued')
    expect(result.selected).toBe(1)
  })
  it('recovers deleted habitual assignments and discovers the latest successful sender',async()=>{
    await pool.query('INSERT INTO campaign_line_assignments VALUES($1,$2,NULL)',[owner,'5491100000001'])
    await pool.query('INSERT INTO campaigns(id,owned_by,status) VALUES($1,$2,\'completed\')',[campaign,owner])
    await pool.query(`INSERT INTO campaign_recipients(campaign_id,phone_number,line_id,status,sent_at) VALUES($1,'5491100000002',$2,'sent',NOW())`,[campaign,b])
    const result=await prepareDailyBroadcast(user,options)
    expect(result.contacts[0].reason).toBeNull()
    expect(result.contacts[1].lineId).toBe(b)
  })
  it('checks current consent and released frequency records',async()=>{
    await pool.query('UPDATE contacts SET opt_in_marketing=false WHERE id=$1',[id(21)])
    await pool.query(`INSERT INTO contact_send_history(contact_id,sent_at,frequency_released_at) VALUES($1,NOW(),NOW())`,[id(22)])
    const result=await prepareDailyBroadcast(user,options)
    expect(result.contacts[0].reason).toBe('excluded');expect(result.selected).toBe(1)
    await pool.query('UPDATE contact_send_history SET frequency_released_at=NULL')
    expect((await prepareDailyBroadcast(user,options)).selected).toBe(0)
  })
  it('limits templates to accessible accounts and validates their live approval',async()=>{
    await pool.query(`INSERT INTO whatsapp_lines(id,owner_user_id,display_name,line_type) VALUES($1,$2,'Cloud','cloud')`,[cloud,owner])
    await pool.query(`INSERT INTO cloud_numbers(whatsapp_line_id,waba_id,access_token) VALUES($1,'waba','test-token')`,[cloud])
    await pool.query(`INSERT INTO whatsapp_templates VALUES($1,'Aprobada','waba','APROBADA','remote-id'),($2,'Privada','another','APROBADA','remote-id')`,[id(81),id(82)])
    expect((await getBroadcastPlanningOptions(user)).templates.map(t=>t.id)).toEqual([id(81)])
    expect((await prepareDailyBroadcast(user,{...options,lineIds:[cloud],messageType:'template',templateId:id(81)})).selected).toBe(2)
    await pool.query(`UPDATE whatsapp_templates SET status='RECHAZADA' WHERE id=$1`,[id(81)])
    await expect(prepareDailyBroadcast(user,{...options,lineIds:[cloud],messageType:'template',templateId:id(81)})).rejects.toThrow('plantilla aprobada')
  })
  it('uses canonical deposit activity and scopes blacklists to the contact agent',async()=>{
    await pool.query("INSERT INTO blacklist(phone_number_normalized,scope_key,agent_code) VALUES('5491100000001','agent:other','other')")
    expect((await prepareDailyBroadcast(user,options)).selected).toBe(2)
    await pool.query("UPDATE blacklist SET agent_code='royal'")
    expect((await prepareDailyBroadcast(user,options)).contacts[0].reason).toBe('excluded')
    await pool.query("UPDATE contacts SET segmentation_profile=jsonb_build_object('last_date',CURRENT_DATE::text,'monthly_average',1000) WHERE id=$1",[id(22)])
    expect((await prepareDailyBroadcast(user,options)).selected).toBe(0)
  })
  it('caps configured capacity by the existing recommendation',async()=>{
    const result=await prepareDailyBroadcast(user,options)
    expect(result.lines[0]).toMatchObject({dailyLimit:100,recommendedRemaining:25,capacity:25})
    expect(getLineVolumeInputs).toHaveBeenLastCalledWith([a,b],expect.any(Date),expect.any(Function))
  })

})
