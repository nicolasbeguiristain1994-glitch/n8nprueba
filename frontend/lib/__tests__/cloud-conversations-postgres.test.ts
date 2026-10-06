// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'
import { NextRequest } from 'next/server'
const mocks=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn(),auth:vi.fn(),lines:vi.fn()}))
vi.mock('@/lib/db',()=>({query:mocks.query,withTransaction:mocks.transaction}))
vi.mock('@/lib/permissions',()=>({checkPermissionWithUser:mocks.auth}))
vi.mock('@/lib/line-visibility',()=>({getAccessibleLineIds:mocks.lines}))
import { GET as windowGET } from '@/app/api/conversations/window/route'
import { GET } from '@/app/api/conversations/route'
import { cloudMessageText,cloudMessageTextSql } from '../cloud-api/message-content'
import { conversationRepository } from '../cloud-api/repositories/conversation.repository'
import { findConversationReplyLine } from '../conversation-reply-line'
import type { EligibleLine } from '../campaign-distributor'
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const phone='5491100000001'
const request=(query='')=>new NextRequest('https://panel.test/api/conversations'+query)

describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS!=='1')('unified conversations on PostgreSQL',()=>{
 let db:Client
 beforeAll(async()=>{
  const url=new URL(process.env.DATABASE_URL!)
  if(!['localhost','127.0.0.1'].includes(url.hostname))throw Error('LOCAL_ONLY')
  db=new Client({connectionString:url.toString(),ssl:false});await db.connect();await db.query('BEGIN')
  await db.query(`SET LOCAL search_path=pg_temp,public;
   CREATE TEMP TABLE whatsapp_messages(id uuid DEFAULT gen_random_uuid(),phone_number text,message_body text,direction text,status text,created_at timestamptz,evolution_message_id text,campaign_id uuid);
   CREATE TEMP TABLE campaigns(id uuid PRIMARY KEY,name text);
   CREATE TEMP TABLE cloud_numbers(phone_number_id text,whatsapp_line_id uuid);
   CREATE TEMP TABLE whatsapp_lines(id uuid,display_name text,line_key text);
   CREATE TEMP TABLE cloud_conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),phone_number_id text,contact_phone text,window_opens_at timestamptz,window_expires_at timestamptz,window_type text,last_message_at timestamptz,last_message_preview text,unread_count int DEFAULT 0,status text,updated_at timestamptz,UNIQUE(phone_number_id,contact_phone));
   CREATE TEMP TABLE cloud_messages(id uuid DEFAULT gen_random_uuid(),conversation_id uuid,phone_number_id text,wamid text UNIQUE,direction text,message_type text,content jsonb,status text,sent_at timestamptz,created_at timestamptz DEFAULT NOW(),campaign_id uuid);
   CREATE TEMP TABLE contacts(id uuid,phone_number text,first_name text,last_name text,segment text,deleted_at timestamptz,panel text);
   CREATE TEMP TABLE contact_tags(contact_id uuid,tag text);
   CREATE TEMP TABLE conversation_state(phone_number text,is_escalated bool,escalation_reason text,current_flow text,resolved_at timestamptz);
   CREATE TEMP TABLE blacklist(phone_number_normalized text,removed_at timestamptz);
   CREATE TEMP TABLE conversation_notes(phone text,content text);`)
  mocks.query.mockImplementation(async(sql,params)=>(await db.query(sql,params)).rows)
  mocks.transaction.mockImplementation(fn=>fn(db))
 })
 beforeEach(async()=>{
  await db.query('SAVEPOINT test_case')
  mocks.auth.mockResolvedValue({ok:true,user:{user_id:id(900),role:'admin',is_super_admin:false}});mocks.lines.mockResolvedValue([id(10)])
  await db.query(`INSERT INTO cloud_numbers VALUES('10001',$1),('10002',$2)`,[id(10),id(11)])
  await db.query(`INSERT INTO whatsapp_lines VALUES($1,'Difusion 1','a'),($2,'Difusion 2','b')`,[id(10),id(11)])
  await db.query(`INSERT INTO cloud_conversations(id,phone_number_id,contact_phone,last_message_preview) VALUES('${id(1)}','10001','+${phone}','[button]'),('${id(2)}','10002','+5491100000002','hidden');`)
  await db.query(`INSERT INTO whatsapp_messages(id,phone_number,message_body,direction,status,created_at,evolution_message_id) VALUES($1,$2,'[template:test]','outbound','delivered',NOW()-interval '2 minutes','wamid.out')`,[id(100),phone])
  await db.query(`INSERT INTO contacts VALUES('${id(20)}','+${phone}','Prueba',NULL,NULL,NULL,'royal');`)
  await db.query(`INSERT INTO cloud_messages(conversation_id,phone_number_id,wamid,direction,message_type,content,status,sent_at) VALUES
   ($1,'10001','wamid.button','inbound','button','{"type":"button","button":{"text":"Mas información","payload":"info"}}','delivered',NOW()-interval '1 minute'),
   ($2,'10002','wamid.hidden','inbound','text','{"text":{"body":"private"}}','delivered',NOW());`,[id(1),id(2)])
 })
 afterEach(async()=>{await db.query('ROLLBACK TO SAVEPOINT test_case')})
 afterAll(async()=>{if(db){await db.query('ROLLBACK');await db.end()}})
 it('shows an already stored button in the same thread as its campaign, with the contact name and inbound preview',async()=>{
  const r=await GET(request());expect(r.status).toBe(200);const body=await r.json()
  expect(body.total).toBe(1);expect(body.conversations).toHaveLength(1)
  expect(body.conversations[0]).toMatchObject({phone_number:phone,last_message:'Mas información',last_direction:'inbound',first_name:'Prueba'})
  const detail=await (await GET(request('?phone='+phone))).json()
  expect(detail.messages.map((m:{message_body:string})=>m.message_body)).toEqual(['[template:test]','Mas información'])
 })
 it('keeps all successfully sent campaigns after inbound and manual replies, newest campaign first',async()=>{
  await db.query(`INSERT INTO campaigns VALUES($1,'Bono anterior'),($2,'Extra Royal'),($3,'Fallida')`,[id(301),id(302),id(303)])
  await db.query('UPDATE whatsapp_messages SET campaign_id=$1',[id(301)])
  await db.query("UPDATE contacts SET segment='vip_alto'")
  await db.query(`INSERT INTO cloud_messages(conversation_id,phone_number_id,wamid,direction,message_type,content,status,sent_at,campaign_id) VALUES
    ($1,'10001','wamid.campaign','outbound','text','{"text":{"body":"Extra"}}','read',NOW()-interval '90 seconds',$2),
    ($1,'10001','wamid.failed','outbound','text','{}','failed',NOW(),$3),
    ($1,'10001','wamid.queued','outbound','text','{}','queued',NOW(),$3),
    ($1,'10001','wamid.manual','outbound','text','{"text":{"body":"Saludos"}}','sent',NOW(),NULL)`,[id(1),id(302),id(303)])
  const body=await (await GET(request())).json()
  expect(body.conversations[0].segment).toBe('vip_alto')
  expect(body.conversations[0].campaigns.map((c:{id:string})=>c.id)).toEqual([id(302),id(301)])
  expect(body.campaigns).toEqual([{id:id(301),name:'Bono anterior',count:1},{id:id(302),name:'Extra Royal',count:1}])
  for(const campaign of [301,302]) {
    const filtered=await (await GET(request('?campaign='+id(campaign)+'&level=vip_alto'))).json()
    expect(filtered.total).toBe(1);expect(filtered.conversations[0].phone_number).toBe(phone)
  }
  expect((await (await GET(request('?campaign='+id(303)))).json()).total).toBe(0)
  expect((await (await GET(request('?level=vip_medio'))).json()).total).toBe(0)
  expect((await (await GET(request('?campaign=none'))).json()).total).toBe(0)
 })
 it('does not expose campaign metadata from hidden Cloud lines, even for the same contact',async()=>{
  await db.query(`INSERT INTO campaigns VALUES($1,'Private campaign')`,[id(301)])
  await db.query('UPDATE cloud_conversations SET contact_phone=$1 WHERE id=$2',['+'+phone,id(2)])
  await db.query("UPDATE cloud_messages SET campaign_id=$1,direction='outbound' WHERE phone_number_id='10002'",[id(301)])
  const body=await (await GET(request())).json()
  expect(body.campaigns).toEqual([]);expect(body.conversations[0].campaigns).toEqual([])
  expect((await (await GET(request('?campaign='+id(301)))).json()).total).toBe(0)
  mocks.lines.mockResolvedValue(null)
  expect((await (await GET(request())).json()).campaigns).toEqual([{id:id(301),name:'Private campaign',count:1}])
 })
 it('filters campaigns and levels before pagination and includes options beyond the first page',async()=>{
  await db.query(`INSERT INTO campaigns VALUES($1,'Older campaign')`,[id(301)])
  await db.query('UPDATE whatsapp_messages SET campaign_id=$1',[id(301)])
  await db.query("UPDATE contacts SET segment='vip_medio'")
  await db.query(`INSERT INTO whatsapp_messages(phone_number,message_body,direction,status,created_at)
    SELECT '5491200'||lpad(n::text,6,'0'),'newer','inbound','received',NOW() FROM generate_series(1,205) n`)
  const all=await (await GET(request())).json()
  expect(all.total).toBe(206);expect(all.conversations).toHaveLength(200);expect(all.has_more).toBe(true)
  expect(all.campaigns).toEqual([{id:id(301),name:'Older campaign',count:1}])
  expect(all.agents).toEqual([{name:'royal',count:1}])
  const agentOnly=await(await GET(request('?agent=royal&level=vip_medio'))).json()
  expect(agentOnly.total).toBe(1);expect(agentOnly.conversations[0].agent).toBe('royal')
  expect((await(await GET(request('?agent=none'))).json()).total).toBe(205)
  expect((await(await GET(request('?agent=ofizeus'))).json()).total).toBe(0)
  const page=await (await GET(request('?offset=200'))).json()
  expect(page.conversations).toHaveLength(6);expect(page.has_more).toBe(false)
  const filtered=await (await GET(request('?campaign='+id(301)+'&level=vip_medio'))).json()
  expect(filtered.total).toBe(1);expect(filtered.conversations[0].phone_number).toBe(phone)
  const noCampaign=await (await GET(request('?campaign=none&level=none&offset=200'))).json()
  expect(noCampaign.total).toBe(205);expect(noCampaign.conversations).toHaveLength(5)
 })
 it.each(['super_vip','vip_alto','vip_medio','vip','medio','bajo','casual','regular','whale'])('returns the exact %s contact level',async level=>{
  await db.query('UPDATE contacts SET segment=$1',[level])
  const body=await (await GET(request('?level='+level))).json()
  expect(body.total).toBe(1);expect(body.conversations[0].segment).toBe(level)
 })
 it('keeps one thread per normalized phone if contacts exist with and without the plus prefix',async()=>{
  await db.query(`INSERT INTO contacts VALUES($1,$2,'Duplicate',NULL,'bajo',NULL,'royal')`,[id(21),phone])
  const body=await (await GET(request())).json()
  expect(body.total).toBe(1);expect(body.conversations).toHaveLength(1)
  expect(body.conversations[0].first_name).toBe('Prueba')
 })
 it.each(['?level=unknown','?campaign=invalid'])('rejects invalid filters: %s',async query=>{
  expect((await GET(request(query))).status).toBe(400)
 })
 it('applies Cloud line visibility to both list and direct phone lookup',async()=>{
  expect((await (await GET(request('?phone=5491100000002'))).json()).messages).toEqual([])
  mocks.lines.mockResolvedValue([])
  const body=await (await GET(request('?phone='+phone))).json()
  expect(body.messages).toHaveLength(1);expect(body.messages[0].direction).toBe('outbound')
  mocks.lines.mockResolvedValue(null)
  expect((await (await GET(request())).json()).total).toBe(2)
 })
 it('does not duplicate a WAMID recorded in both message stores',async()=>{
  await db.query(`INSERT INTO whatsapp_messages(phone_number,message_body,direction,status,created_at,evolution_message_id) VALUES($1,'Mas información','inbound','received',NOW(),'wamid.button')`,[phone])
  expect((await (await GET(request('?phone='+phone))).json()).messages).toHaveLength(2)
 })
 it('keeps the newest 200 messages so a recent response is not hidden by old history',async()=>{
  await db.query(`INSERT INTO whatsapp_messages(phone_number,message_body,direction,status,created_at) SELECT $1,'old','inbound','received',NOW()-interval '1 day'-n*interval '1 second' FROM generate_series(1,230) n`,[phone])
  const body=await (await GET(request('?phone='+phone))).json();expect(body.messages).toHaveLength(200);expect(body.messages.at(-1).message_body).toBe('Mas información')
 })
 it.each([
  [{text:{body:'Hola'}},'text','Hola'],
  [{button:{text:'Mas información',payload:'info'}},'button','Mas información'],
  [{interactive:{button_reply:{title:'Ayuda'}}},'interactive','Ayuda'],
  [{interactive:{list_reply:{title:'Catálogo'}}},'interactive','Catálogo'],
  [{image:{caption:'Foto'}},'image','Foto'],
  [{document:{filename:'archivo.pdf'}},'document','archivo.pdf'],
  [{},'audio','[audio]'],
 ] as const)('renders the same readable content in SQL and the Cloud inbox: %s',async(content,type,expected)=>{
  expect(cloudMessageText(content,type)).toBe(expected)
  const row=(await db.query(`SELECT ${cloudMessageTextSql('m.content','m.message_type')} AS text FROM (SELECT $1::jsonb AS content,$2::text AS message_type) m`,[JSON.stringify(content),type])).rows[0]
  expect(row.text).toBe(expected)
 })
 it('persists button text once and a webhook replay does not add unread messages or reopen the window',async()=>{
  const msg={id:'wamid.replay',from:phone,timestamp:String(Math.floor(Date.now()/1000)-60),type:'button' as const,button:{text:'Mas información',payload:'info'}}
  await conversationRepository.receive('10001','+'+phone,msg)
  const first=(await db.query('SELECT * FROM cloud_conversations WHERE id=$1',[id(1)])).rows[0]
  await conversationRepository.receive('10001','+'+phone,msg)
  const second=(await db.query('SELECT * FROM cloud_conversations WHERE id=$1',[id(1)])).rows[0]
  expect(second.last_message_preview).toBe('Mas información');expect(second.unread_count).toBe(1)
  expect(second.window_expires_at).toEqual(first.window_expires_at)
  expect((await db.query("SELECT COUNT(*)::int AS n FROM cloud_messages WHERE wamid='wamid.replay'")).rows[0].n).toBe(1)
 })
 it('returns the permission denial without reading either message store',async()=>{
  mocks.auth.mockResolvedValue({ok:false,response:Response.json({error:'Forbidden'},{status:403})})
  const count=mocks.query.mock.calls.length;expect((await GET(request())).status).toBe(403);expect(mocks.query.mock.calls.length).toBe(count)
 })
 it('routes a button reply to the receiving line even when another line is preferred',async()=>{
  const a={id:id(10),phone_number_id:'10001'} as EligibleLine
  const b={id:id(11),phone_number_id:'10002'} as EligibleLine
  expect(await findConversationReplyLine('+'+phone,[a.id,b.id],[b,a])).toEqual(a)
 })
 it('selects the latest visible inbound and never uses hidden-line history',async()=>{
  const a={id:id(10),phone_number_id:'10001'} as EligibleLine
  const b={id:id(11),phone_number_id:'10002'} as EligibleLine
  await db.query('UPDATE cloud_conversations SET contact_phone=$1 WHERE id=$2',['+'+phone,id(2)])
  expect(await findConversationReplyLine(phone,[a.id],[a,b])).toEqual(a)
  expect(await findConversationReplyLine(phone,null,[a,b])).toEqual(b)
  expect(await findConversationReplyLine(phone,[],[a,b])).toBeNull()
 })
 it('reports an unavailable original line instead of choosing a different eligible line',async()=>{
  const b={id:id(11),phone_number_id:'10002'} as EligibleLine
  await expect(findConversationReplyLine(phone,[id(10),id(11)],[b])).rejects.toThrow('Difusion 1')
 })
 it('does not choose a sender from an outbound-only history or a cached window',async()=>{
  await db.query("UPDATE cloud_messages SET direction='outbound' WHERE wamid='wamid.button'")
  const a={id:id(10),phone_number_id:'10001'} as EligibleLine
  expect(await findConversationReplyLine(phone,[a.id],[a])).toBeNull()
 })
 it('shows the window of the same latest visible Cloud line used for replies',async()=>{
   await db.query("UPDATE cloud_conversations SET window_expires_at=NOW()+interval '2 hours' WHERE id=$1",[id(1)])
   const response=await windowGET(request('?phone='+phone));expect(response.status).toBe(200)
   const data=await response.json();expect(data.window.lineName).toBe('Difusion 1')
   expect(Date.parse(data.window.expiresAt)-Date.parse(data.serverNow)).toBeGreaterThan(7190000)
   mocks.lines.mockResolvedValue([])
   expect((await (await windowGET(request('?phone='+phone))).json()).window).toBeNull()
 })
 it('shows closed windows and rejects deleted contacts',async()=>{
   expect((await (await windowGET(request('?phone='+phone))).json()).window.expiresAt).toBeNull()
   await db.query('UPDATE contacts SET deleted_at=NOW()')
   expect((await windowGET(request('?phone='+phone))).status).toBe(403)
 })

})
