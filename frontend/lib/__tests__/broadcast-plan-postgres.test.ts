/** @vitest-environment node */
import { beforeAll,afterAll,beforeEach,describe,it,expect,vi } from 'vitest'
import { Pool } from 'pg'
import { broadcastPlanningDays } from '@/lib/broadcast-planner'
import { getLineVolumeInputs } from '@/lib/line-volume-data'
import { NextRequest } from 'next/server'
import { POST as createCampaign } from '@/app/api/campaigns/route'
import { campaignRoutingCondition } from '@/lib/campaign-routing'
import { checkPermissionWithUser } from '@/lib/permissions'
import { query, withTransaction } from '@/lib/db'
import { getBroadcastPlanningOptions,prepareDailyBroadcast } from '@/lib/broadcast-plan-repository'
import { INACTIVITY_WINDOWS,RECONTACT_COOLDOWN_DAYS,VALUE_SCORES } from '@/lib/user-prioritization/config'
import type { SessionUser } from '@/lib/auth'

vi.mock('@/lib/permissions',()=>({checkPermissionWithUser:vi.fn(),isOwnerOrAdmin:()=>true}))
vi.mock('@/lib/audit',()=>({audit:vi.fn()}))
vi.mock('@/lib/security-log',()=>({securityLog:vi.fn()}))
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
      CREATE TABLE campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owned_by uuid,status text DEFAULT 'running',scheduled_at timestamptz,
        name text CHECK(name<>'force-failure'),message text,messages jsonb,media_url text,media_type text,list_id uuid,prospect_list_id uuid,type text,
        total_targets int,antiblock_delay_min int,antiblock_delay_max int,personalize_name bool,use_multi_line bool,updated_by uuid,
        message_type text,template_id uuid,template_params jsonb,agent_key text,broadcast_plan jsonb,audience_snapshot_at timestamptz,is_priority_broadcast bool DEFAULT false);
      CREATE TABLE contact_lists(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,description text,source text,filters jsonb,owned_by uuid,updated_by uuid,is_dynamic bool,refreshed_at timestamptz);
      CREATE TABLE contact_list_members(list_id uuid,contact_id uuid,PRIMARY KEY(list_id,contact_id));
      CREATE TABLE campaign_audience_members(campaign_id uuid,contact_id uuid,PRIMARY KEY(campaign_id,contact_id));
      CREATE TABLE priority_broadcasts(campaign_id uuid PRIMARY KEY,request_hash text,actor_name text);
      CREATE TABLE campaign_recipients(id uuid DEFAULT gen_random_uuid(),campaign_id uuid,contact_id uuid,phone_number text,line_id uuid,agent_code text,created_at timestamptz DEFAULT NOW(),status text DEFAULT 'pending',sent_at timestamptz,updated_at timestamptz DEFAULT NOW(),error_detail text);
      CREATE TABLE campaign_line_assignments(owner_key uuid,phone text,line_id uuid,source text,assigned_at timestamptz DEFAULT NOW(),PRIMARY KEY(owner_key,phone));
      CREATE TABLE phone_line_assignments(phone text,line_id uuid,updated_at timestamptz DEFAULT NOW());
      CREATE TABLE contact_send_history(contact_id uuid,sent_at timestamptz,campaign_recipient_id uuid,frequency_released_at timestamptz);
      CREATE TABLE whatsapp_messages(id uuid,campaign_recipient_id uuid,direction text,status text,error_detail text,updated_at timestamptz);
      CREATE TABLE contact_frequency_rules(id uuid,operator_id uuid,seg_monto text,seg_actividad text,max_per_day int,max_per_week int,min_hours_between_sends int,is_active bool,created_at timestamptz,updated_at timestamptz);
    `)
    vi.mocked(query).mockImplementation(async <T,>(sql:string,args?:unknown[]) => (await pool.query(sql,args)).rows as T[])
    vi.mocked(withTransaction).mockImplementation(async work=>{
      const client=await pool.connect()
      try {await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result}
      catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
    })
  })
  afterAll(async()=>{vi.unstubAllEnvs();if(pool){await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()}})
  beforeEach(async()=>{
    vi.mocked(checkPermissionWithUser).mockResolvedValue({ok:true,user})
    vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED','true');vi.stubEnv('CRON_SECRET','test-only')
    vi.mocked(getLineVolumeInputs).mockImplementation(async ids => (ids ?? []).map(id => ({id,lineType:'evolution',status:'active',isConnected:true,sendingEnabled:true,campaignsAllowed:true,dailyLimit:100,hourlyLimit:100,dailyUsed:0,hourlyUsed:0,cloudStatus:null,quality:null,lastMetaCheckAt:null,activeRiskReasons:[],recentDays:[],now:new Date().toISOString()})))
    await pool.query(`TRUNCATE contact_lists,contact_list_members,campaign_audience_members,priority_broadcasts,whatsapp_lines,cloud_numbers,cloud_conversations,cloud_messages,whatsapp_templates,contacts,contact_priority_scores,system_jobs,operator_contact_visibility,blacklist,campaigns,campaign_recipients,campaign_line_assignments,phone_line_assignments,contact_send_history,whatsapp_messages,contact_frequency_rules`)
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
    await pool.query('INSERT INTO campaign_line_assignments(owner_key,phone,line_id) VALUES($1,$2,NULL)',[owner,'5491100000001'])
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

  it('uses exact planning dates, excludes commitments after the chosen close and never mutates counters',async()=>{
    const days=broadcastPlanningDays(new Date())
    const target=days[1].date
    await pool.query('INSERT INTO campaigns(id,owned_by,scheduled_at) VALUES($1,$2,$3),($4,$2,$5),($6,$2,$7)',[campaign,other,`${target}T08:00:00-03:00`,id(71),`${target}T12:00:00-03:00`,id(72),`${days[2].date}T08:00:00-03:00`])
    await pool.query("INSERT INTO campaign_recipients(campaign_id,phone_number,line_id) VALUES($1,'5491199999991',$4),($2,'5491199999992',$4),($3,'5491199999993',$4)",[campaign,id(71),id(72),a])
    await pool.query('UPDATE whatsapp_lines SET msgs_sent_today=100,day_reset_at=$1,hour_reset_at=$1',[`${target}T00:00:00-03:00`])
    const result=await prepareDailyBroadcast(user,{...options,planDate:target,startTime:'09:00',endTime:'10:00'})
    expect(result).toMatchObject({planDate:target,startsAt:`${target}T12:00:00.000Z`,endsAt:`${target}T13:00:00.000Z`})
    expect(result.lines[0]).toMatchObject({committed:1,used:0,capacity:24})
    expect((await pool.query('SELECT msgs_sent_today FROM whatsapp_lines WHERE id=$1',[a])).rows[0].msgs_sent_today).toBe(100)
    for (const invalid of ['2000-01-01','2099-01-01','2026-99-99'])
      await expect(prepareDailyBroadcast(user,{...options,planDate:invalid})).rejects.toMatchObject({status:400})
  })
  it('evaluates rolling history at the selected date without releasing frequency records',async()=>{
    const target=broadcastPlanningDays(new Date())[1].date
    await pool.query('INSERT INTO contact_send_history(contact_id,sent_at) VALUES($1,$2)',[id(21),`${target}T09:00:00-03:00`])
    await pool.query("UPDATE contact_send_history SET sent_at=sent_at-interval '8 days'")
    await pool.query("INSERT INTO contact_send_history SELECT contact_id,sent_at+interval '12 hours',NULL,NULL FROM contact_send_history")
    const result=await prepareDailyBroadcast(user,{...options,planDate:target})
    expect(result.contacts.find(c=>c.id===id(21))?.reason).toBeNull()
    expect((await pool.query('SELECT count(*)::int n FROM contact_send_history WHERE frequency_released_at IS NULL')).rows[0].n).toBe(2)
  })

  const request = (body:unknown) => new NextRequest('http://localhost/api/campaigns',{method:'POST',body:JSON.stringify(body)})
  async function campaignInput() {
    const opts={...options,planDate:broadcastPlanningDays(new Date())[1].date,startTime:'09:00'}
    const plan=await prepareDailyBroadcast(user,opts)
    return {plan,body:{name:'Desde plan',message_type:'text' as const,message:'Hola',contact_ids:plan.contacts.filter(c=>!c.reason).map(c=>c.id),
      broadcast_plan:{requestId:id(90),fingerprint:plan.fingerprint,options:opts}}}
  }
  it('creates an exact frozen draft and preserves senders, without consuming quota or sending',async()=>{
    const {plan,body}=await campaignInput()
    const response=await createCampaign(request(body));expect(response.status).toBe(200)
    const saved=(await pool.query('SELECT * FROM campaigns WHERE id=$1',[id(90)])).rows[0]
    expect(saved).toMatchObject({status:'draft',scheduled_at:null,total_targets:2,is_priority_broadcast:true,broadcast_plan:{startsAt:plan.startsAt,endsAt:plan.endsAt}})
    const recipients=(await pool.query('SELECT contact_id,line_id FROM campaign_recipients ORDER BY contact_id')).rows
    expect(recipients).toEqual(plan.contacts.filter(c=>!c.reason).map(c=>({contact_id:c.id,line_id:c.lineId})).sort((a,b)=>a.contact_id.localeCompare(b.contact_id)))
    expect((await pool.query('SELECT contact_id FROM campaign_recipients ORDER BY created_at,id')).rows.map(r=>r.contact_id)).toEqual(plan.contacts.filter(c=>!c.reason).map(c=>c.id))
    expect((await pool.query('SELECT count(*)::int n FROM campaign_audience_members')).rows[0].n).toBe(2)
    expect((await pool.query('SELECT count(*)::int n FROM whatsapp_messages')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT sum(msgs_sent_today)::int n FROM whatsapp_lines')).rows[0].n).toBe(0)
  })
  it('returns the same campaign for concurrent identical retries and rejects changed content',async()=>{
    const {body}=await campaignInput()
    const results=await Promise.all([createCampaign(request(body)),createCampaign(request(body))])
    expect(results.map(r=>r.status)).toEqual([200,200])
    expect((await pool.query('SELECT count(*)::int n FROM campaigns')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM contact_lists')).rows[0].n).toBe(1)
    expect((await createCampaign(request({...body,message:'Otro mensaje'}))).status).toBe(409)
  })
  it.each(['optout','phone','line','tamper'])('requires a new review for %s changes and leaves no partial campaign',async change=>{
    const {body}=await campaignInput()
    if(change==='optout')await pool.query('UPDATE contacts SET do_not_contact=true WHERE id=$1',[id(21)])
    if(change==='phone')await pool.query("UPDATE contacts SET phone_number='5491100000044' WHERE id=$1",[id(21)])
    if(change==='line')await pool.query('UPDATE whatsapp_lines SET sending_enabled=false WHERE id=$1',[a])
    if(change==='tamper')body.contact_ids=[id(999)]
    const response=await createCampaign(request(body));expect(response.status).toBe(409)
    expect(await response.json()).toHaveProperty('plan.fingerprint')
    expect((await pool.query('SELECT count(*)::int n FROM campaigns')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM contact_lists')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM campaign_line_assignments')).rows[0].n).toBe(0)
  })
  it('schedules only inside the reviewed window and requires send permission',async()=>{
    const {plan,body}=await campaignInput()
    expect((await createCampaign(request({...body,scheduled_at:plan.endsAt}))).status).toBe(400)
    vi.mocked(checkPermissionWithUser).mockImplementation(async (_req,resource)=>resource==='send' ? {ok:false,response:Response.json({error:'Forbidden'},{status:403})} as never : {ok:true,user})
    expect((await createCampaign(request({...body,scheduled_at:plan.startsAt}))).status).toBe(403)
    vi.mocked(checkPermissionWithUser).mockResolvedValue({ok:true,user})
    expect((await createCampaign(request({...body,scheduled_at:plan.startsAt}))).status).toBe(200)
    expect((await pool.query('SELECT status,scheduled_at FROM campaigns')).rows[0]).toMatchObject({status:'scheduled',scheduled_at:new Date(plan.startsAt)})
  })
  it.each(['priorities','lines'])('requires %s permission on creation, not just on preview',async resource=>{
    const {body}=await campaignInput()
    vi.mocked(checkPermissionWithUser).mockImplementation(async (_req,r)=>r===resource ? {ok:false,response:Response.json({error:'Forbidden'},{status:403})} as never : {ok:true,user})
    expect((await createCampaign(request(body))).status).toBe(403)
    expect((await pool.query('SELECT count(*)::int n FROM campaigns')).rows[0].n).toBe(0)
  })
  it('rolls back the audience and assignments on an insertion failure',async()=>{
    const {body}=await campaignInput()
    expect((await createCampaign(request({...body,name:'force-failure'}))).status).toBe(500)
    expect((await pool.query('SELECT count(*)::int n FROM contact_lists')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM campaign_recipients')).rows[0].n).toBe(0)
  })
  it('fences claims outside the plan window or on a different sender, including later routing changes',async()=>{
    const {body}=await campaignInput();expect((await createCampaign(request(body))).status).toBe(200)
    const claimable=async(line:string)=>(await pool.query(`SELECT cr.contact_id FROM campaign_recipients cr WHERE ${campaignRoutingCondition('cr','ARRAY[$1::uuid]')}`,[line])).rows
    expect(await claimable(a)).toHaveLength(0)
    await pool.query(`UPDATE campaigns SET broadcast_plan=broadcast_plan || jsonb_build_object('startsAt',NOW()-interval '1 minute','endsAt',NOW()+interval '1 minute')`)
    expect(await claimable(a)).toHaveLength(1)
    await pool.query('UPDATE campaign_line_assignments SET line_id=$1 WHERE line_id=$2',[b,a])
    expect(await claimable(b)).toHaveLength(1)
    await pool.query(`UPDATE campaigns SET broadcast_plan=broadcast_plan || jsonb_build_object('endsAt',NOW()-interval '1 second')`)
    expect(await claimable(b)).toHaveLength(0)
  })

  it('keeps ordinary campaign routing unchanged when the new plan column is SQL NULL',async()=>{
    await pool.query('INSERT INTO campaigns(id,owned_by) VALUES($1,$2)',[campaign,owner])
    await pool.query("INSERT INTO campaign_recipients(campaign_id,phone_number) VALUES($1,'5491100000001')",[campaign])
    await pool.query("INSERT INTO campaign_line_assignments(owner_key,phone,line_id) VALUES($1,'5491100000001',$2)",[owner,a])
    const rows=(await pool.query(`SELECT cr.id FROM campaign_recipients cr WHERE ${campaignRoutingCondition('cr','ARRAY[$1::uuid]')}`,[a])).rows
    expect(rows).toHaveLength(1)
  })

  it('explains blocked recommendations in the catalogue before suggesting any line',async()=>{
    vi.mocked(getLineVolumeInputs).mockResolvedValue([])
    const catalogue=await getBroadcastPlanningOptions(user)
    expect(catalogue.lines.every(l=>!!l.unavailableReason)).toBe(true)
  })

  it('recalculates capacity for a later scheduled start instead of promising the whole-day quota',async()=>{
    const {plan,body}=await campaignInput()
    const response=await createCampaign(request({...body,scheduled_at:new Date(Date.parse(plan.endsAt)-1000).toISOString()}))
    expect(response.status).toBe(409)
    expect((await response.json()).plan.selected).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM campaigns')).rows[0].n).toBe(0)
  })

})
