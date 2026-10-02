// @vitest-environment node
import {afterAll,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest'
import {Client} from 'pg'
import {NextRequest} from 'next/server'
const mocks=vi.hoisted(()=>({query:vi.fn()}))
vi.mock('@/lib/db',()=>({query:mocks.query}))
vi.mock('@/lib/permissions',()=>({checkPermissionWithUser:async()=>({ok:true,user:{role:'admin',user_id:'11111111-1111-4111-8111-111111111111'}}),isOwnerOrAdmin:()=>true}))
vi.mock('@/lib/line-visibility',()=>({getAccessibleLineIds:async()=>null}))
vi.mock('@/lib/audit',()=>({audit:vi.fn()}))
vi.mock('@/lib/security-log',()=>({securityLog:vi.fn()}))
import {POST} from '@/app/api/campaigns/route'
const list='22222222-2222-4222-8222-222222222222',template='33333333-3333-4333-8333-333333333333'
describe.skipIf(process.env.RUN_CAMPAIGN_PG_TESTS!=='1')('Campaign creation with production columns and no retired workflow fields',()=>{
 let db:Client
 beforeAll(async()=>{
  const url=new URL(process.env.DATABASE_URL!);if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('LOCAL_ONLY')
  db=new Client({connectionString:url.toString(),ssl:false});await db.connect();await db.query('BEGIN')
  await db.query(`CREATE TEMP TABLE campaigns (
   id uuid DEFAULT gen_random_uuid(),name varchar NOT NULL,message text,messages jsonb NOT NULL DEFAULT '[]',
   media_url text,media_type text,list_id uuid,prospect_list_id uuid,type text NOT NULL,status text,scheduled_at timestamptz,
   total_targets integer NOT NULL,antiblock_delay_min integer NOT NULL,antiblock_delay_max integer NOT NULL,
   personalize_name boolean NOT NULL,use_multi_line boolean NOT NULL,owned_by uuid,updated_by uuid,
   message_type text NOT NULL,template_id uuid,template_params jsonb)`)
  mocks.query.mockImplementation(async(sql:string,args:unknown[])=>{
   if(sql.includes('INSERT INTO campaigns'))return (await db.query(sql,args)).rows
   if(sql.includes('FROM whatsapp_templates'))return [{name:'campa_prueba',status:'APROBADA',waba_id:'123',components:[{type:'BODY',text:'Hola {{1}}'},{type:'BUTTONS',buttons:[{type:'QUICK_REPLY',text:'Mas información'}]}]}]
   if(sql.includes('FROM cloud_numbers'))return [{id:template}]
   if(sql.includes('COUNT(*)'))return [{count:1}]
   return [{id:list,owned_by:null}]
  })
 })
 beforeEach(()=>{vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED','true');vi.stubEnv('CRON_SECRET','local-test')})
 afterAll(async()=>{vi.unstubAllEnvs();if(db){await db.query('ROLLBACK');await db.end()}})
 it.each(['contact','prospect'])('stores scheduled template and correct bindings for %s audience',async audience=>{
  const response=await POST(new NextRequest('https://example.test/api/campaigns',{method:'POST',body:JSON.stringify({name:'Prueba1',message_type:'template',template_id:template,template_params:{body:['nombre']},[audience==='contact'?'list_id':'prospect_list_id']:list,scheduled_at:'2030-01-01T19:20',antiblock_delay_min:3,antiblock_delay_max:8})}))
  expect(response.status).toBe(200);const result=await response.json();const row=(await db.query('SELECT * FROM campaigns WHERE id=$1',[result.id])).rows[0]
  expect(row).toMatchObject({status:'scheduled',message_type:'template',template_id:template,template_params:{body:['nombre']},use_multi_line:true,total_targets:1,antiblock_delay_min:3,antiblock_delay_max:8,owned_by:'11111111-1111-4111-8111-111111111111',updated_by:'11111111-1111-4111-8111-111111111111'})
  expect(row.scheduled_at.toISOString()).toBe('2030-01-01T22:20:00.000Z')
  expect(row.list_id).toBe(audience==='contact'?list:null);expect(row.prospect_list_id).toBe(audience==='prospect'?list:null)
 })
 it('keeps unscheduled text as draft',async()=>{
  const response=await POST(new NextRequest('https://example.test/api/campaigns',{method:'POST',body:JSON.stringify({name:'Draft',message:'Hola'})}))
  expect(response.status).toBe(200);const row=(await db.query('SELECT * FROM campaigns WHERE id=$1',[(await response.json()).id])).rows[0]
  expect(row).toMatchObject({status:'draft',scheduled_at:null,message_type:'text',template_id:null,template_params:null,use_multi_line:true,messages:['Hola']})
 })
})
