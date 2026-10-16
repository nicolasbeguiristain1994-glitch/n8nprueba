// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { NextRequest } from 'next/server'
const mocks=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn(),auth:vi.fn(),filters:vi.fn()}))
vi.mock('@/lib/db',()=>({query:mocks.query,withTransaction:mocks.transaction}))
vi.mock('@/lib/permissions',()=>({checkPermissionWithUser:mocks.auth,isOwnerOrAdmin:(u:{role:string;user_id:string},owner:string)=>u.role==='admin'||u.user_id===owner}))
vi.mock('@/lib/contact-filters',()=>({resolvedContactFilters:mocks.filters}))
vi.mock('@/lib/security-log',()=>({securityLog:vi.fn()}))
vi.mock('@/lib/audit',()=>({audit:vi.fn()}))
import { previewCampaignRouting, outsidePreviewWindow } from '../campaign-routing-preview'
import { prepareCampaignRouting } from '../campaign-routing'
import { POST } from '@/app/api/campaigns/routing-preview/route'
const id=(n:number)=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`
const owner=id(1),other=id(2),a=id(11),b=id(12),c=id(13),campaign=id(20),tpl=id(30),list=id(40)
const phone=(n:number)=>`549110000${String(n).padStart(4,'0')}`
const req=(body:unknown)=>new NextRequest('https://example.test/api/campaigns/routing-preview',{method:'POST',body:JSON.stringify(body)})

describe.skipIf(!process.env.CONTACTS_TEST_DATABASE_URL)('read-only campaign line forecast on PostgreSQL',()=>{
  let db:Pool
  const schema=`routing_preview_${process.pid}`
  beforeAll(async()=>{
    const url=new URL(process.env.CONTACTS_TEST_DATABASE_URL!)
    if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('LOCAL_ONLY')
    db=new Pool({connectionString:url.toString(),options:`-c search_path=${schema},public`})
    await db.query(`CREATE SCHEMA ${schema};
      CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY,owner_user_id uuid,line_key text,display_name text,phone_number text,
        line_type text DEFAULT 'cloud',status text DEFAULT 'active',is_connected boolean DEFAULT true,sending_enabled boolean DEFAULT true,
        msgs_sent_hour int DEFAULT 0,msgs_sent_today int DEFAULT 0,msg_per_hour int DEFAULT 100,msg_per_day int DEFAULT 500,
        hour_reset_at timestamptz,day_reset_at timestamptz,allowed_types jsonb,personality_config jsonb);
      CREATE TABLE cloud_numbers(id uuid DEFAULT gen_random_uuid(),whatsapp_line_id uuid,phone_number_id text,waba_id text,status text DEFAULT 'active');
      CREATE TABLE campaigns(id uuid PRIMARY KEY,owned_by uuid);
      CREATE TABLE campaign_recipients(campaign_id uuid,phone_number text,line_id uuid,status text DEFAULT 'pending',sent_at timestamptz,updated_at timestamptz DEFAULT now());
      CREATE TABLE cloud_conversations(id uuid,contact_phone text);
      CREATE TABLE cloud_messages(conversation_id uuid,phone_number_id text,direction text,status text,sent_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE phone_line_assignments(phone text,line_id uuid,updated_at timestamptz);
      CREATE TABLE campaign_line_assignments(owner_key uuid,phone text,line_id uuid,source text,assigned_at timestamptz DEFAULT now(),PRIMARY KEY(owner_key,phone));
      CREATE TABLE campaign_line_rotation(owner_key uuid PRIMARY KEY,next_position bigint DEFAULT 0);
      CREATE FUNCTION get_accessible_line_ids(actor uuid) RETURNS SETOF uuid LANGUAGE sql AS 'SELECT id FROM whatsapp_lines WHERE owner_user_id=actor';
      CREATE FUNCTION contact_agent_key(agent text) RETURNS text LANGUAGE sql AS 'SELECT lower(agent)';
      CREATE TABLE contacts(id uuid PRIMARY KEY,phone_number text,panel text DEFAULT 'royal',status text DEFAULT 'active',opt_in_marketing boolean DEFAULT true,do_not_contact boolean DEFAULT false,deleted_at timestamptz);
      CREATE TABLE blacklist(phone_number_normalized text,scope_key text DEFAULT 'global',agent_code text,removed_at timestamptz);
      CREATE TABLE operator_contact_visibility(contact_id uuid,operator_id uuid);
      CREATE TABLE contact_lists(id uuid PRIMARY KEY,owned_by uuid,is_dynamic boolean DEFAULT false,filters jsonb);
      CREATE TABLE contact_list_members(list_id uuid,contact_id uuid);
      CREATE TABLE prospects(id uuid PRIMARY KEY,phone_number text,status text DEFAULT 'active',opt_in boolean DEFAULT true,stage text);
      CREATE TABLE prospect_lists(id uuid PRIMARY KEY,owned_by uuid);
      CREATE TABLE prospect_list_members(prospect_list_id uuid,prospect_id uuid);
      CREATE TABLE whatsapp_templates(id uuid PRIMARY KEY,status text,waba_id text);
    `)
    mocks.query.mockImplementation(async(sql,params)=>(await db.query(sql,params)).rows)
    mocks.transaction.mockImplementation(async fn=>{
      const client=await db.connect()
      try{await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value}
      catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
    })
  })
  beforeEach(async()=>{
    mocks.auth.mockResolvedValue({ok:true,user:{user_id:owner,role:'admin'}})
    await db.query(`TRUNCATE whatsapp_lines,cloud_numbers,campaigns,campaign_recipients,cloud_conversations,cloud_messages,
      phone_line_assignments,campaign_line_assignments,campaign_line_rotation,contacts,blacklist,operator_contact_visibility,
      contact_lists,contact_list_members,prospects,prospect_lists,prospect_list_members,whatsapp_templates`)
    await db.query(`INSERT INTO whatsapp_lines(id,owner_user_id,line_key,display_name) VALUES($1,$3,'lexora','Lexora'),($2,$3,'lexora2','Lexora 2')`,[a,b,owner])
    await db.query(`INSERT INTO cloud_numbers(whatsapp_line_id,phone_number_id,waba_id) VALUES($1,'p1','lexora'),($2,'p2','lexora')`,[a,b])
    await db.query('INSERT INTO campaigns VALUES($1,$2)',[campaign,owner])
    await db.query("INSERT INTO whatsapp_templates VALUES($1,'APROBADA','lexora')",[tpl])
    await db.query("INSERT INTO contacts(id,phone_number) SELECT $1,n FROM unnest($2::text[]) n",[id(101),[phone(1)]])
  })
  afterAll(async()=>{if(db){await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end()}})
  const forecast=(phones:string[],waba:string|null='lexora')=>previewCampaignRouting(phones,owner,waba)
  it('matches actual rotation across two Lexora lines without changing assignments or rotation',async()=>{
    await db.query('INSERT INTO campaign_line_rotation VALUES($1,1)',[owner])
    const phones=Array.from({length:5},(_,n)=>phone(n+1)),preview=await forecast(phones)
    expect(preview.lines.map(l=>[l.id,l.new])).toEqual([[b,3],[a,2]])
    expect((await db.query('SELECT * FROM campaign_line_assignments')).rows).toHaveLength(0)
    expect((await db.query('SELECT next_position::int n FROM campaign_line_rotation')).rows).toEqual([{n:1}])
    await db.query('INSERT INTO campaign_recipients(campaign_id,phone_number) SELECT $1,unnest($2::text[])',[campaign,phones])
    await prepareCampaignRouting(campaign,[b,a])
    expect((await db.query('SELECT line_id,COUNT(*)::int n FROM campaign_line_assignments GROUP BY line_id ORDER BY n DESC')).rows)
      .toEqual(preview.lines.map(l=>({line_id:l.id,n:l.assigned})))
  })
  it('preserves existing lines, recovers latest successful history and ignores failures',async()=>{
    await db.query("INSERT INTO campaign_line_assignments VALUES($1,$2,$3,'rotation')",[owner,phone(1),b])
    await db.query(`INSERT INTO campaign_recipients(campaign_id,phone_number,line_id,status,sent_at) VALUES
      ($1,$2,$3,'sent','2026-10-01'),($1,$2,$4,'failed','2026-10-02')`,[campaign,phone(2),b,a])
    await db.query('INSERT INTO cloud_conversations VALUES($1,$2)',[id(60),phone(3)])
    await db.query("INSERT INTO cloud_messages(conversation_id,phone_number_id,direction,status) VALUES($1,'p1','outbound','read')",[id(60)])
    const result=await forecast([phone(1),phone(2),phone(3),phone(4)])
    expect(result.lines.find(l=>l.id===b)).toMatchObject({assigned:2,habitual:2,new:0})
    expect(result.lines.find(l=>l.id===a)).toMatchObject({assigned:2,habitual:1,new:1})
    await db.query('INSERT INTO campaign_recipients(campaign_id,phone_number) SELECT $1,unnest($2::text[])',[campaign,[1,2,3,4].map(phone)])
    await prepareCampaignRouting(campaign,[a,b])
    expect((await db.query('SELECT line_id,COUNT(*)::int n FROM campaign_line_assignments GROUP BY line_id ORDER BY line_id')).rows)
      .toEqual([{line_id:a,n:2},{line_id:b,n:2}])
  })
  it('reports unavailable habitual lines and quota overflow without redistributing them',async()=>{
    await db.query("INSERT INTO campaign_line_assignments(owner_key,phone,line_id,source) VALUES($1,$2,$3,'history')",[owner,phone(1),b])
    await db.query('UPDATE whatsapp_lines SET sending_enabled=false WHERE id=$1',[b])
    await db.query('UPDATE whatsapp_lines SET msgs_sent_hour=99 WHERE id=$1',[a])
    const result=await forecast([1,2,3,4].map(phone))
    expect(result.pending).toBe(3)
    expect(result.lines.find(l=>l.id===b)).toMatchObject({assigned:1,pending:1,reason:'Envíos deshabilitados'})
    expect(result.lines.find(l=>l.id===a)).toMatchObject({assigned:3,pending:2,remaining_hour:1})
  })
  it('simulates expired quota resets using SELECT and leaves counters unchanged',async()=>{
    await db.query("UPDATE whatsapp_lines SET msgs_sent_hour=100,msgs_sent_today=500,hour_reset_at=now()-interval '1 minute',day_reset_at=now()-interval '1 minute'")
    const result=await forecast([phone(1),phone(2)])
    expect(result.pending).toBe(0)
    expect(result.lines.every(l=>l.remaining_hour===100&&l.remaining_day===500)).toBe(true)
    expect((await db.query('SELECT msgs_sent_hour,msgs_sent_today FROM whatsapp_lines')).rows)
      .toEqual([{msgs_sent_hour:100,msgs_sent_today:500},{msgs_sent_hour:100,msgs_sent_today:500}])
  })
  it('does not route fresh recipients to another WABA and preserves incompatible affinity',async()=>{
    await db.query("UPDATE cloud_numbers SET waba_id='nexus' WHERE whatsapp_line_id=$1",[b])
    await db.query("INSERT INTO campaign_line_assignments VALUES($1,$2,$3,'rotation')",[owner,phone(1),b])
    const result=await forecast([phone(1),phone(2),phone(3)])
    expect(result.lines.find(l=>l.id===a)).toMatchObject({assigned:2,new:2})
    expect(result.lines.find(l=>l.id===b)).toMatchObject({assigned:1,pending:1,reason:'No compatible con esta plantilla'})
  })
  it('hides names and ids of inaccessible historical lines and isolates ownership',async()=>{
    await db.query("INSERT INTO whatsapp_lines(id,owner_user_id,line_key,display_name) VALUES($1,$2,'secret','Secret line')",[c,other])
    await db.query("INSERT INTO campaign_line_assignments(owner_key,phone,line_id,source) VALUES($1,$3,$4,'rotation'),($2,$5,$4,'rotation')",[owner,other,phone(1),c,phone(2)])
    const result=await forecast([phone(1),phone(2)])
    expect(result.hidden_line_contacts).toBe(1);expect(result.pending).toBe(1)
    expect(JSON.stringify(result)).not.toContain(c);expect(JSON.stringify(result)).not.toContain('Secret')
    expect(result.lines.find(l=>l.id===a)?.new).toBe(1)
  })
  it('keeps everyone pending if no line is eligible, including empty audiences',async()=>{
    await db.query('UPDATE whatsapp_lines SET sending_enabled=false')
    expect(await forecast([phone(1)])).toMatchObject({eligible:1,unassigned:1,pending:1,lines:[]})
    expect(await forecast([])).toMatchObject({eligible:0,unassigned:0,pending:0,lines:[]})
  })
  it('checks consent per agent before deduplicating selected phones, within a read-only transaction',async()=>{
    await db.query("INSERT INTO contacts(id,phone_number,panel) VALUES($1,$2,'bigwin'),($3,$2,'royal')",[id(102),phone(1),id(103)])
    await db.query("INSERT INTO blacklist(phone_number_normalized,scope_key,agent_code) VALUES($1,'agent:bigwin','bigwin')",[phone(1)])
    const response=await POST(req({contact_ids:[id(101),id(102),id(103)],message_type:'template',template_id:tpl}))
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({eligible:1,excluded:2,assigned:1})
    expect((await db.query('SELECT * FROM campaign_line_assignments')).rows).toHaveLength(0)
  })
  it('supports existing contact lists and dynamically resolves saved filters without updating membership',async()=>{
    await db.query('INSERT INTO contact_lists(id,owned_by) VALUES($1,$2)',[list,owner])
    await db.query('INSERT INTO contact_list_members VALUES($1,$2)',[list,id(101)])
    const body={list_id:list,message_type:'text'}
    expect(await (await POST(req(body))).json()).toMatchObject({eligible:1})
    await db.query("UPDATE contact_lists SET is_dynamic=true,filters='{}'")
    mocks.filters.mockResolvedValue({sql:'false',params:[]})
    expect(await (await POST(req(body))).json()).toMatchObject({eligible:0})
    expect((await db.query('SELECT * FROM contact_list_members')).rows).toHaveLength(1)
  })
  it('supports prospect lists and excludes opted-out prospects',async()=>{
    await db.query('INSERT INTO prospect_lists VALUES($1,$2)',[list,owner])
    await db.query('INSERT INTO prospects(id,phone_number,opt_in) VALUES($1,$3,true),($2,$4,false)',[id(201),id(202),phone(1),phone(2)])
    await db.query('INSERT INTO prospect_list_members VALUES($1,$2),($1,$3)',[list,id(201),id(202)])
    expect(await (await POST(req({prospect_list_id:list,message_type:'text'}))).json()).toMatchObject({eligible:1,excluded:1})
  })
  it('rejects foreign lists and inaccessible templates',async()=>{
    mocks.auth.mockResolvedValue({ok:true,user:{user_id:owner,role:'operator'}})
    await db.query('INSERT INTO contact_lists(id,owned_by) VALUES($1,$2)',[list,other])
    expect((await POST(req({list_id:list,message_type:'text'}))).status).toBe(403)
    expect((await POST(req({contact_ids:[id(101)],message_type:'template',template_id:id(999)}))).status).toBe(403)
  })
  it.each(['campaigns','contacts'])('requires %s permission for selected audiences',async resource=>{
    mocks.auth.mockImplementation(async(_req,r)=>r===resource?{ok:false,response:Response.json({error:'Forbidden'},{status:403})}:{ok:true,user:{role:'admin',user_id:owner}})
    expect((await POST(req({contact_ids:[id(101)],message_type:'text'}))).status).toBe(403)
  })
  it.each([{}, {contact_ids:[]}, {contact_ids:[id(101)],list_id:list}, {contact_ids:[id(101)],message_type:'template'}, {contact_ids:[id(101)],message_type:'text',template_id:tpl}])('rejects incomplete or ambiguous inputs',async body=>{
    expect((await POST(req({message_type:'text',...body}))).status).toBe(400)
  })
})

it('respects overnight line windows and exempts Cloud lines',()=>{
  const personality_config={activeHours:[19,3],timezoneOffsetHours:-3,aggressiveness:1}
  expect(outsidePreviewWindow({line_type:'evolution',personality_config},new Date('2026-10-15T01:00:00Z'))).toBe(false)
  expect(outsidePreviewWindow({line_type:'evolution',personality_config},new Date('2026-10-15T15:00:00Z'))).toBe(true)
  expect(outsidePreviewWindow({line_type:'cloud',personality_config},new Date('2026-10-15T15:00:00Z'))).toBe(false)
})
