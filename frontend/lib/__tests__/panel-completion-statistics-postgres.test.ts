// @vitest-environment node
import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest'
import {Client} from 'pg'
import {NextRequest} from 'next/server'
const m=vi.hoisted(()=>({query:vi.fn(),auth:vi.fn()}))
vi.mock('@/lib/db',()=>({query:m.query}))
vi.mock('@/lib/permissions',()=>({checkPermissionWithUser:m.auth}))
import {GET as overview} from '@/app/api/stats/overview/route'
import {GET as campaigns} from '@/app/api/stats/campaigns/route'
import {GET as exportCsv} from '@/app/api/stats/export/route'
import {GET as templates} from '@/app/api/stats/templates/route'
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const req=(suffix:string)=>new NextRequest('http://localhost/api/stats/'+suffix+(suffix.includes('?')?'&':'?')+'from=2026-09-30&to=2026-09-30')
describe.skipIf(!process.env.OPS_TEST_DATABASE_URL && process.env.RUN_CAMPAIGN_PG_TESTS!=='1')('statistics metrics, scope and calendar days',()=>{
 let db:Client
 beforeAll(async()=>{
  const url=new URL((process.env.OPS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL)!);if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('LOCAL_ONLY')
  db=new Client({connectionString:url.toString(),ssl:false});await db.connect()
  await db.query(`BEGIN;CREATE SCHEMA stats_completion_${process.pid};SET LOCAL search_path=stats_completion_${process.pid};
   CREATE TABLE campaigns(id uuid PRIMARY KEY,owned_by uuid,name text,type text,status text,created_at timestamptz,completed_at timestamptz);
   CREATE TABLE campaign_recipients(campaign_id uuid,phone_number text,status text);
   CREATE TABLE whatsapp_messages(id uuid,campaign_id uuid,template_id uuid,phone_number text,direction text,status text,created_at timestamptz,evolution_message_id text,whatsapp_message_id text);
   CREATE TABLE cloud_messages(id uuid,campaign_id uuid,conversation_id uuid,phone_number_id text,direction text,status text,sent_at timestamptz,created_at timestamptz,template_name text,content jsonb,wamid text);
   CREATE TABLE cloud_conversations(id uuid,contact_phone text);
   CREATE TABLE cloud_numbers(phone_number_id text,waba_id text);
   CREATE TABLE whatsapp_templates(id uuid PRIMARY KEY,name text,waba_id text,category text,language text,status text,usage_count int,last_used_at timestamptz,created_at timestamptz);
   CREATE TABLE contacts(id uuid,phone_number text);
   CREATE TABLE operator_contact_visibility(operator_id uuid,contact_id uuid);
   INSERT INTO campaigns VALUES('${id(1)}','${id(10)}','=Own,"quoted"','broadcast','completed','2026-09-30T15:00:00Z',NULL),('${id(2)}','${id(20)}','Secret other','broadcast','completed','2026-09-30T16:00:00Z',NULL);
   INSERT INTO campaign_recipients VALUES('${id(1)}','+5491100000001','sent'),('${id(2)}','+5491100000002','sent');
   INSERT INTO whatsapp_templates VALUES('${id(90)}','template','waba','MARKETING','es_AR','approved',3,NULL,NOW());
   INSERT INTO whatsapp_messages VALUES
    ('${id(100)}','${id(1)}','${id(90)}','+5491100000001','outbound','failed','2026-09-30T20:00:00Z',NULL,NULL),
    ('${id(101)}','${id(1)}','${id(90)}','+5491100000001','outbound','read','2026-10-01T02:59:00Z','wamid.same',NULL),
    ('${id(102)}','${id(2)}','${id(90)}','+5491100000002','outbound','sent','2026-09-30T22:00:00Z',NULL,NULL),
    ('${id(103)}',NULL,NULL,'+5491100000001','inbound','received','2026-10-01T03:00:00Z',NULL,NULL);
   INSERT INTO cloud_numbers VALUES('phone','waba');INSERT INTO cloud_conversations VALUES('${id(80)}','+5491100000001');
   INSERT INTO cloud_messages VALUES
    ('${id(104)}','${id(1)}','${id(80)}','phone','outbound','read','2026-10-01T02:59:00Z',NOW(),'template','{}','wamid.same'),
    ('${id(105)}',NULL,'${id(80)}','phone','outbound','delivered','2026-09-30T23:00:00Z',NOW(),NULL,'{}','wamid.manual');
   INSERT INTO contacts VALUES('${id(70)}','5491100000001');INSERT INTO operator_contact_visibility VALUES('${id(10)}','${id(70)}');
   ALTER TABLE cloud_numbers ADD whatsapp_line_id uuid;
   UPDATE cloud_numbers SET whatsapp_line_id='${id(60)}';
   INSERT INTO cloud_numbers VALUES('other-phone','waba','${id(61)}');
   ALTER TABLE cloud_conversations ADD phone_number_id text;
   UPDATE cloud_conversations SET phone_number_id='phone';
   ALTER TABLE campaign_recipients ADD id uuid,ADD line_id uuid,ADD sent_at timestamptz,ADD evolution_message_id text;
   UPDATE campaign_recipients SET id='${id(50)}',line_id='${id(60)}' WHERE campaign_id='${id(1)}';
   UPDATE campaign_recipients SET id='${id(51)}',line_id='${id(61)}' WHERE campaign_id='${id(2)}';
   ALTER TABLE whatsapp_messages ADD sent_at timestamptz,ADD campaign_recipient_id uuid,ADD original_campaign_recipient_id uuid;
   ALTER TABLE campaign_recipients ADD contact_id uuid;
   UPDATE campaign_recipients SET contact_id='${id(70)}' WHERE campaign_id='${id(1)}';
   CREATE TABLE casino_contact_account_links(contact_id uuid,platform text,username_lower text);
   ALTER TABLE contacts ADD first_name text,ADD last_name text,ADD deleted_at timestamptz,ADD casino_accounts jsonb DEFAULT '[]';
   CREATE VIEW casino_players AS SELECT DISTINCT md5(platform || ':' || username_lower)::uuid AS id,platform,username_lower,'admin'::text AS agente FROM casino_contact_account_links;
   CREATE TABLE casino_transactions(id bigint,platform text,username text,tipo text,monto numeric,fecha date,fecha_hora_utc timestamptz,raw_detalles text);
   ALTER TABLE casino_transactions ADD source_id text, ADD agente text;
   CREATE TABLE casino_financial_source_records(transaction_id bigint,platform text,kind text,monto numeric);`)
  m.query.mockImplementation(async(sql,params)=>(await db.query(sql,params)).rows)
  m.auth.mockResolvedValue({ok:true,user:{role:'operator',user_id:id(10)}})
 })
 afterAll(async()=>{await db.query('ROLLBACK');await db.end()})
 it('counts latest retries once, reads as delivered, manual Cloud and Argentina midnight',async()=>{
  const r=await overview(req('overview'));expect(r.status).toBe(200)
  const d=await r.json();expect(d.kpis).toMatchObject({enviados:2,entregados:2,leidos:1,fallidos:0,respuestas:0})
  expect(d.series).toEqual([expect.objectContaining({dia:'2026-09-30',enviados:2})]);expect(d.campaignCount.total).toBe(1)
  expect(d.topCampaigns).toHaveLength(1)
 })
 it('uses matching recipient outcomes in summary/detail/CSV and scopes other owners',async()=>{
  const list=await (await campaigns(req('campaigns'))).json();expect(list.campaigns).toHaveLength(1)
  expect(list.campaigns[0]).toMatchObject({enviados:1,entregados:1,leidos:1,fallidos:0})
  const detail=await(await campaigns(req('campaigns?id='+id(1)))).json();expect(detail.kpis.enviados).toBe(1);expect(detail.series[0]).toMatchObject({enviados:1,respuestas:0});expect(detail.kpis.respuestas).toBe(0)
  expect((await campaigns(req('campaigns?id='+id(2)))).status).toBe(404)
  const csv=await(await exportCsv(req('export?type=campaigns'))).text();expect(csv).toContain(`"'=Own,""quoted"""`);expect(csv).not.toContain('Secret other')
 })
 it('uses the same retry result for template analytics',async()=>{
  const r=await templates(req('templates'));expect(r.status).toBe(200)
  expect((await r.json()).templates[0]).toMatchObject({enviados:1,leidos:1})
 })
 it('shares 24-hour effectiveness across list/detail/CSV, beyond the selected date range',async()=>{
  await db.query('SAVEPOINT campaign_effectiveness')
  try {
   await db.query(`INSERT INTO casino_contact_account_links VALUES('${id(70)}','bet30','player');
    UPDATE contacts SET casino_accounts='[{"platform":"bet30","username":"player"}]' WHERE id='${id(70)}';
    INSERT INTO casino_transactions(id,platform,username,tipo,monto,fecha,fecha_hora_utc,raw_detalles) VALUES(1,'bet30','player','carga',1234.56,'2026-10-01','2026-10-01T04:00:00Z',NULL)`)
   const list=await(await campaigns(req('campaigns'))).json()
   expect(list.campaigns[0]).toMatchObject({efectivos:1,tasa_efectividad:'100.0',monto_cargado_24h:'1234.56'})
   const detail=await(await campaigns(req('campaigns?id='+id(1)))).json()
   expect(detail.kpis).toMatchObject({efectivos:1,tasa_efectividad:'100.0',monto_cargado_24h:'1234.56',monto_apostado_24h:null})
   expect(detail.efectivos).toHaveLength(1)
   const csv=await(await exportCsv(req('export?type=campaigns'))).text()
   expect(csv).toContain('"Efectivos (24 h)","Efectividad %","Cargas (24 h)","Monto cargado (24 h)"')
   expect(csv).toContain('"1","100.0","1","1234.56","No disponible"')
   m.query.mockClear()
   expect((await campaigns(req('campaigns?id='+id(2)))).status).toBe(404)
   expect(m.query).toHaveBeenCalledTimes(1)
  } finally {await db.query('ROLLBACK TO SAVEPOINT campaign_effectiveness')}
 })
 it('counts Cloud replies and linked legacy replies once, including days with only replies',async()=>{
  await db.query('SAVEPOINT reply_counts')
  try {
   await db.query(`INSERT INTO cloud_messages(id,conversation_id,phone_number_id,direction,status,sent_at,created_at,content,wamid) VALUES
    ('${id(201)}','${id(80)}','phone','inbound','delivered','2026-10-01T02:59:30Z',NOW(),'{}','reply.one'),
    ('${id(202)}','${id(80)}','phone','inbound','delivered','2026-10-01T03:00:00Z',NOW(),'{"context":{"id":"wamid.same"}}','reply.two'),
    ('${id(205)}','${id(80)}','phone','inbound','delivered','2026-10-01T03:10:00Z',NOW(),'{}','reply.three');
    INSERT INTO whatsapp_messages(id,campaign_id,phone_number,direction,status,created_at,evolution_message_id) VALUES
    ('${id(203)}','${id(1)}','+5491100000001','inbound','received','2026-10-01T03:01:00Z','legacy.reply'),
    ('${id(204)}','${id(1)}','+5491100000001','inbound','received','2026-10-01T02:59:30Z','reply.one');
    UPDATE cloud_messages SET campaign_id='${id(1)}' WHERE id='${id(205)}'`)
   const list=await(await campaigns(req('campaigns'))).json()
   const detail=await(await campaigns(req('campaigns?id='+id(1)))).json()
   expect(list.campaigns[0].respuestas).toBe(4);expect(detail.kpis.respuestas).toBe(4)
   expect(detail.series).toEqual([
    {dia:'2026-09-30',enviados:1,entregados:1,leidos:1,respuestas:1},
    {dia:'2026-10-01',enviados:0,entregados:0,leidos:0,respuestas:3},
   ])
   const csv=await(await exportCsv(req('export?type=campaigns'))).text()
   const [header,row]=csv.trim().split('\r\n')
   expect(header).toContain('"Leídos","Respuestas","Fallidos"')
   expect(row).toContain('"1","1","1","4","0"')
  } finally { await db.query('ROLLBACK TO SAVEPOINT reply_counts') }
 })
 it('attributes to the latest campaign across owners, but honors a quoted older campaign',async()=>{
  await db.query('SAVEPOINT reply_ownership')
  try {
   await db.query(`INSERT INTO cloud_messages(id,campaign_id,conversation_id,phone_number_id,direction,status,sent_at,created_at,content,wamid) VALUES
    ('${id(210)}','${id(2)}','${id(80)}','phone','outbound','sent','2026-10-01T04:00:00Z',NOW(),'{}','campaign.two'),
    ('${id(211)}',NULL,'${id(80)}','phone','inbound','delivered','2026-10-01T04:01:00Z',NOW(),'{}','latest.reply'),
    ('${id(212)}',NULL,'${id(80)}','phone','inbound','delivered','2026-10-01T04:02:00Z',NOW(),'{"context":{"id":"wamid.same"}}','quoted.reply')`)
   const detail=await(await campaigns(req('campaigns?id='+id(1)))).json();expect(detail.kpis.respuestas).toBe(1)
   expect((await campaigns(req('campaigns?id='+id(2)))).status).toBe(404)
   m.auth.mockResolvedValue({ok:true,user:{role:'admin',user_id:id(10)}})
   const other=await(await campaigns(req('campaigns?id='+id(2)))).json();expect(other.kpis.respuestas).toBe(1)
  } finally {
   m.auth.mockResolvedValue({ok:true,user:{role:'operator',user_id:id(10)}})
   await db.query('ROLLBACK TO SAVEPOINT reply_ownership')
  }
 })
 it('ignores replies before delivery, other lines, unknown contexts and quoted manual messages',async()=>{
  await db.query('SAVEPOINT reply_boundaries')
  try {
   await db.query(`INSERT INTO cloud_conversations VALUES('${id(81)}','+5491100000001','other-phone');
    INSERT INTO cloud_messages(id,campaign_id,conversation_id,phone_number_id,direction,status,sent_at,created_at,content,wamid) VALUES
    ('${id(220)}',NULL,'${id(80)}','phone','inbound','delivered','2026-10-01T02:58:00Z',NOW(),'{}','before.reply'),
    ('${id(221)}',NULL,'${id(81)}','other-phone','inbound','delivered','2026-10-01T04:00:00Z',NOW(),'{}','other.line'),
    ('${id(222)}',NULL,'${id(80)}','phone','inbound','delivered','2026-10-01T04:00:00Z',NOW(),'{"context":{"id":"missing"}}','unknown.quote'),
    ('${id(223)}',NULL,'${id(80)}','phone','inbound','delivered','2026-10-01T04:00:00Z',NOW(),'{"context":{"id":"wamid.manual"}}','manual.quote'),
    ('${id(224)}',NULL,'${id(81)}','other-phone','inbound','delivered','2026-10-01T04:00:00Z',NOW(),'{"context":{"id":"wamid.same"}}','cross.line.quote'),
    ('${id(225)}',NULL,'${id(80)}','phone','inbound','delivered','2026-10-01T02:58:00Z',NOW(),'{"context":{"id":"wamid.same"}}','future.quote'),
    ('${id(226)}','${id(2)}','${id(80)}','phone','outbound','failed','2026-10-01T04:01:00Z',NOW(),'{}','failed.send'),
    ('${id(227)}',NULL,'${id(80)}','phone','inbound','delivered','2026-10-01T04:02:00Z',NOW(),'{}','after.failed.send')`)
   const detail=await(await campaigns(req('campaigns?id='+id(1)))).json()
   expect(detail.kpis.respuestas).toBe(1)
   expect(detail.series.find((day:{dia:string})=>day.dia==='2026-10-01').respuestas).toBe(1)
  } finally { await db.query('ROLLBACK TO SAVEPOINT reply_boundaries') }
 })
 it('rejects bad periods before SQL and shares overview CSV series',async()=>{
  const r=await exportCsv(new NextRequest('http://localhost/api/stats/export?from=2026-02-30&to=2026-03-01'));expect(r.status).toBe(400)
  const csv=await(await exportCsv(req('export?type=overview'))).text();expect(csv).toContain('"2026-09-30","2","2","1","0","0"')
 })
 it('counts Cloud replies when the actual campaign sender only writes to the legacy log',async()=>{
  await db.query('SAVEPOINT legacy_campaign_replies')
  try {
   // sendViaCloud persists through whatsapp_messages + campaign_recipients,
   // while the inbound webhook persists only through cloud_messages.
   await db.query(`DELETE FROM cloud_messages WHERE direction='outbound';
    UPDATE whatsapp_messages SET campaign_recipient_id='${id(50)}',sent_at='2026-10-01T02:59:00Z'
      WHERE id='${id(101)}';
    INSERT INTO cloud_messages(id,conversation_id,phone_number_id,direction,status,sent_at,created_at,content,wamid) VALUES
    ('${id(240)}','${id(80)}','phone','inbound','delivered','2026-10-01T02:59:30Z',NOW(),'{}','legacy-send.reply'),
    ('${id(241)}','${id(80)}','phone','inbound','delivered','2026-10-01T03:01:00Z',NOW(),'{"context":{"id":"wamid.same"}}','legacy-send.quoted')`)
   const detail=await(await campaigns(req('campaigns?id='+id(1)))).json()
   expect(detail.kpis.respuestas).toBe(2)
   expect(detail.series.map((day:{respuestas:number})=>day.respuestas)).toEqual([1,1])
   const list=await(await campaigns(req('campaigns'))).json();expect(list.campaigns[0].respuestas).toBe(2)
   // Historical sends can lack the direct recipient link and use either ID column.
   await db.query(`UPDATE whatsapp_messages SET campaign_recipient_id=NULL,
     whatsapp_message_id=evolution_message_id,evolution_message_id=NULL,phone_number='54911 0000 0001'
     WHERE id='${id(101)}'`)
   expect((await(await campaigns(req('campaigns?id='+id(1)))).json()).kpis.respuestas).toBe(2)
  } finally { await db.query('ROLLBACK TO SAVEPOINT legacy_campaign_replies') }
 })
 it('uses the actual send time and sender line when joining the two message stores',async()=>{
  await db.query('SAVEPOINT legacy_sender_boundaries')
  try {
   await db.query(`DELETE FROM cloud_messages WHERE direction='outbound';
    UPDATE whatsapp_messages SET sent_at='2026-10-01T04:00:00Z',campaign_recipient_id='${id(50)}' WHERE id='${id(101)}';
    INSERT INTO cloud_messages(id,conversation_id,phone_number_id,direction,status,sent_at,created_at,content,wamid) VALUES
    ('${id(250)}','${id(80)}','phone','inbound','delivered','2026-10-01T03:00:00Z',NOW(),'{}','before.actual.send'),
    ('${id(251)}','${id(80)}','other-phone','inbound','delivered','2026-10-01T04:01:00Z',NOW(),'{}','wrong.sender'),
    ('${id(252)}','${id(80)}','phone','inbound','delivered','2026-10-01T04:02:00Z',NOW(),'{}','right.sender')`)
   expect((await(await campaigns(req('campaigns?id='+id(1)))).json()).kpis.respuestas).toBe(1)
  } finally { await db.query('ROLLBACK TO SAVEPOINT legacy_sender_boundaries') }
 })
})
