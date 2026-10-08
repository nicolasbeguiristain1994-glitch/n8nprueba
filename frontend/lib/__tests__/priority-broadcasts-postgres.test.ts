// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import type { SessionUser } from '../auth'
const dbMock=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn()}))
vi.mock('@/lib/db',()=>({query:dbMock.query,withTransaction:dbMock.transaction}))
vi.mock('@/lib/line-visibility',()=>({getAccessibleLineIds:async()=>null,distributorVisibilityClause:()=>({clause:'',params:[]})}))
import { preparePriorityBroadcast, priorityRecipientAllowed } from '../user-prioritization/broadcasts'
import { UserPrioritizationRepository } from '../user-prioritization/UserPrioritizationRepository'
import { createDispatchUnits } from '../campaign-distributor'

const owner=randomUUID(),other=randomUUID(),template=randomUUID(),contact=randomUUID(),second=randomUUID(),run=randomUUID()
const user={user_id:owner,role:'admin',name:'Operador de prueba',email:'qa@example.test',sectors:[],is_super_admin:true,session_version:1,can_download_contacts:true,allowed_agents:[],iat:0,exp:9999999999,nonce:'test'} as SessionUser
const selection=(ids=[contact])=>({request_id:randomUUID(),contact_ids:ids,template_id:template,template_params:{body:['Hola']}})
describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS!=='1')('Priority broadcasts: real transactions, frozen audience and message transitions',()=>{
  let pool:Pool
  const schema=`priority_broadcast_test_${process.pid}`
  beforeAll(async()=>{
    const url=new URL(process.env.DATABASE_URL!)
    if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('LOCAL_ONLY')
    pool=new Pool({connectionString:url.toString(),ssl:false,max:5,options:`-c search_path=${schema},public`})
    await pool.query(`CREATE SCHEMA ${schema}`)
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,role text,is_active boolean,sectors text[],allowed_agents text[]);
      CREATE TABLE contacts(id uuid PRIMARY KEY,phone_number text,first_name text,last_name text,panel text,status text DEFAULT 'active',
        deleted_at timestamptz,opt_in_marketing boolean DEFAULT true,do_not_contact boolean DEFAULT false,
        segment text,platforms text[] DEFAULT '{}',last_deposit_at timestamptz,total_deposit_amount numeric);
      CREATE TABLE contact_priority_scores(contact_id uuid PRIMARY KEY REFERENCES contacts(id),is_eligible boolean DEFAULT true,is_broadcasted boolean DEFAULT false,
        broadcasted_at timestamptz,broadcasted_by text,run_id uuid,priority_score numeric DEFAULT 90,reactivation_segment text,value_tier text DEFAULT 'vip',
        days_inactive int,ltv_score int,ltv_tier text);
      CREATE TABLE system_jobs(job_name text,last_complete_run_id uuid,last_success_at timestamptz,is_running boolean DEFAULT false);
      CREATE TABLE blacklist(phone_number_normalized text,removed_at timestamptz);
      CREATE TABLE operator_contact_visibility(operator_id uuid,contact_id uuid);
      CREATE TABLE whatsapp_templates(id uuid PRIMARY KEY,name text,status text,waba_id text,components jsonb);
      CREATE TABLE cloud_numbers(id uuid DEFAULT gen_random_uuid(),waba_id text,status text,whatsapp_line_id uuid);
      CREATE TABLE contact_lists(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name varchar(255),description text,contact_count int,owned_by uuid,
        source varchar(50),is_dynamic boolean DEFAULT false,filters jsonb DEFAULT '{}');
      CREATE TABLE contact_list_members(list_id uuid,contact_id uuid);
      CREATE TABLE campaigns(id uuid PRIMARY KEY,name text,message text,messages jsonb,list_id uuid,type text,status text,total_targets int,
        antiblock_delay_min int,antiblock_delay_max int,personalize_name boolean,use_multi_line boolean,owned_by uuid,updated_by uuid,
        message_type text,template_id uuid,template_params jsonb,audience_snapshot_at timestamptz,processor_locked_at timestamptz,
        created_at timestamptz DEFAULT now());
      CREATE TABLE campaign_audience_members(campaign_id uuid REFERENCES campaigns(id),contact_id uuid,PRIMARY KEY(campaign_id,contact_id));
      CREATE TABLE campaign_recipients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),campaign_id uuid,contact_id uuid,phone_number text,
        status text DEFAULT 'pending',error_detail text);
      CREATE UNIQUE INDEX ON campaign_recipients(campaign_id,contact_id) WHERE contact_id IS NOT NULL;
      CREATE TABLE whatsapp_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),campaign_id uuid,contact_id uuid,campaign_recipient_id uuid,
        direction text DEFAULT 'outbound',status text DEFAULT 'queued',sent_at timestamptz,error_detail text);
      CREATE TABLE contact_send_history(contact_id uuid,sent_at timestamptz);`)
    await pool.query('BEGIN;'+readFileSync('../db/migrations/147_priority_broadcasts.sql','utf8').replaceAll('public.',schema+'.').replace('search_path=public,','search_path='+schema+',')+'COMMIT;')
    dbMock.query.mockImplementation(async(sql,params)=>(await pool.query(sql,params)).rows)
    dbMock.transaction.mockImplementation(async(fn)=>{
      const client=await pool.connect()
      try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result}
      catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
    })
  })
  beforeEach(async()=>{
    await pool.query(`TRUNCATE users,contacts,system_jobs,blacklist,operator_contact_visibility,whatsapp_templates,cloud_numbers,
      contact_lists,contact_list_members,campaigns,campaign_recipients,whatsapp_messages,contact_send_history CASCADE`)
    await pool.query(`INSERT INTO users VALUES($1,'admin',true,'{}','{}'),($2,'operator',true,'{contacts,campaigns,send}','{royal}');
    `,[owner,other])
    await pool.query(`INSERT INTO contacts(id,phone_number,first_name,panel,status) VALUES($1,'+5491100000001','Ana','royal','inactive'),($2,'+5491100000002','Luz','bigwin','active')`,[contact,second])
    await pool.query('INSERT INTO contact_priority_scores(contact_id,run_id) VALUES($1,$3),($2,$3)',[contact,second,run])
    await pool.query("INSERT INTO system_jobs(job_name,last_complete_run_id) VALUES('prioritization_recompute',$1)",[run])
    await pool.query(`INSERT INTO whatsapp_templates VALUES($1,'reactivar','APROBADA','waba','[{"type":"BODY","text":"Mensaje {{1}}"}]')`,[template])
    await pool.query("INSERT INTO cloud_numbers(waba_id,status) VALUES('waba','active')")
  })
  afterAll(async()=>{if(pool){await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()}})
  const score=async()=> (await pool.query('SELECT * FROM contact_priority_scores WHERE contact_id=$1',[contact])).rows[0]
  async function message(batch:string,status='queued') {
    return (await pool.query('INSERT INTO whatsapp_messages(campaign_id,contact_id,status) VALUES($1,$2,$3) RETURNING id',[batch,contact,status])).rows[0].id
  }
  it('deduplicates concurrent repeated requests and freezes the exact chosen audience',async()=>{
    const data=selection([contact,contact,second])
    const results=await Promise.all([preparePriorityBroadcast(user,data),preparePriorityBroadcast(user,data)])
    expect(results.map(r=>r.reused).sort()).toEqual([false,true])
    expect((await pool.query('SELECT * FROM campaigns')).rows).toHaveLength(1)
    expect((await pool.query('SELECT * FROM campaign_audience_members')).rows).toHaveLength(2)
    await expect(preparePriorityBroadcast(user,{...data,contact_ids:[contact]})).rejects.toThrow('otra selección')
    expect((await score()).is_broadcasted).toBe(false)
  })
  it('serializes overlapping selections so only one campaign can reserve a contact',async()=>{
    const results=await Promise.allSettled([preparePriorityBroadcast(user,selection()),preparePriorityBroadcast(user,selection())])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect((await pool.query('SELECT * FROM campaigns')).rows).toHaveLength(1)
  })
  it('rejects stale scores, hidden users, opt-outs and unapproved templates without creating partial lists',async()=>{
    const operator={...user,user_id:other,role:'operator',allowed_agents:['royal']} as SessionUser
    await expect(preparePriorityBroadcast(operator,selection([second]))).rejects.toThrow('selección cambió')
    await pool.query('INSERT INTO operator_contact_visibility VALUES($1,$2)',[other,second])
    await expect(preparePriorityBroadcast(operator,selection())).rejects.toThrow('selección cambió')
    await pool.query('UPDATE contact_priority_scores SET run_id=$1',[randomUUID()])
    await expect(preparePriorityBroadcast(user,selection())).rejects.toThrow('selección cambió')
    await pool.query('UPDATE contact_priority_scores SET run_id=$1',[run])
    await pool.query('UPDATE contacts SET do_not_contact=true WHERE id=$1',[contact])
    await expect(preparePriorityBroadcast(user,selection())).rejects.toThrow('selección cambió')
    await pool.query('UPDATE contacts SET do_not_contact=false')
    await pool.query("UPDATE whatsapp_templates SET status='PENDIENTE'")
    await expect(preparePriorityBroadcast(user,selection())).rejects.toThrow('plantilla aprobada')
    expect((await pool.query('SELECT * FROM contact_lists')).rows).toHaveLength(0)
  })
  it('seeds inactive reactivation targets, keeps the audience fixed and rechecks consent before sending',async()=>{
    const {campaign_id}=await preparePriorityBroadcast(user,selection())
    const {rows:[campaign]}=await pool.query('SELECT * FROM campaigns')
    await pool.query('INSERT INTO contact_list_members VALUES($1,$2)',[campaign.list_id,second])
    expect(await createDispatchUnits(campaign_id,campaign.list_id)).toEqual({total:1,queued:1})
    expect((await pool.query('SELECT contact_id FROM campaign_recipients')).rows).toEqual([{contact_id:contact}])
    expect(await priorityRecipientAllowed(campaign_id,contact,'+5491100000001')).toBe(true)
    await pool.query("INSERT INTO blacklist VALUES('+5491100000001',NULL)")
    expect(await priorityRecipientAllowed(campaign_id,contact,'+5491100000001')).toBe(false)
    await pool.query('TRUNCATE blacklist;UPDATE users SET is_active=false')
    expect(await priorityRecipientAllowed(campaign_id,contact,'+5491100000001')).toBe(false)
  })
  it('only marks confirmed sends; a webhook failure restores pending, without overwriting manual decisions',async()=>{
    const {campaign_id}=await preparePriorityBroadcast(user,selection())
    const id=await message(campaign_id)
    expect((await score()).is_broadcasted).toBe(false)
    await pool.query("UPDATE whatsapp_messages SET status='sent' WHERE id=$1",[id])
    expect(await score()).toMatchObject({is_broadcasted:true,broadcast_campaign_id:campaign_id,broadcasted_by:'Operador de prueba'})
    await pool.query("UPDATE whatsapp_messages SET status='failed' WHERE id=$1",[id])
    expect((await score()).is_broadcasted).toBe(false)
    await pool.query("UPDATE whatsapp_messages SET status='sent' WHERE id=$1",[id])
    const repo=new UserPrioritizationRepository()
    await repo.unmarkBroadcasted(contact,{role:'admin',userId:owner})
    await pool.query("UPDATE whatsapp_messages SET status='delivered' WHERE id=$1",[id])
    expect((await score()).is_broadcasted).toBe(false)
    await repo.markBroadcasted(contact,'Manual',{role:'admin',userId:owner})
    await pool.query("UPDATE whatsapp_messages SET status='failed' WHERE id=$1",[id])
    expect(await score()).toMatchObject({is_broadcasted:true,broadcasted_by:'Manual',broadcast_campaign_id:null})
  })
  it('keeps confirmed broadcasts visible after eligibility recomputation and protects uncertain sends on cancel',async()=>{
    const {campaign_id}=await preparePriorityBroadcast(user,selection())
    await message(campaign_id,'sent')
    await pool.query('UPDATE contact_priority_scores SET is_eligible=false,run_id=$1 WHERE contact_id=$2',[randomUUID(),contact])
    await pool.query('UPDATE contacts SET do_not_contact=true WHERE id=$1',[contact])
    const result=await new UserPrioritizationRepository().getPrioritizedContacts({broadcasted:true,runId:run,access:{role:'admin',userId:owner}})
    expect(result.data.map(c=>c.id)).toEqual([contact])
    await pool.query('UPDATE contacts SET do_not_contact=false')
    await pool.query('UPDATE contact_priority_scores SET is_eligible=true,is_broadcasted=false,run_id=$1',[run])
    await pool.query("UPDATE campaigns SET status='cancelled';UPDATE whatsapp_messages SET status='queued'")
    const {rows:[recipient]}=await pool.query("UPDATE campaign_recipients SET status='failed' WHERE campaign_id=$1 AND contact_id=$2 RETURNING id",[campaign_id,contact])
    await pool.query('UPDATE whatsapp_messages SET campaign_recipient_id=$1',[recipient.id])
    await expect(preparePriorityBroadcast(user,selection())).rejects.toThrow('difusión pendiente')
    await pool.query("UPDATE whatsapp_messages SET status='failed'")
    expect((await preparePriorityBroadcast(user,selection())).reused).toBe(false)
    const security=(await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid='priority_broadcasts'::regclass")).rows[0]
    expect(security.relrowsecurity).toBe(true)
  })
})
