// @vitest-environment node
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
const mocks=vi.hoisted(()=>({query:vi.fn(),permission:vi.fn(),access:vi.fn()}))
vi.mock('@/lib/db',()=>({query:mocks.query}))
vi.mock('@/lib/permissions',()=>({checkPermissionWithUser:mocks.permission,isOwnerOrAdmin:(u:{role:string;user_id:string},owner:string)=>u.role==='admin'||u.user_id===owner}))
vi.mock('@/lib/line-visibility',()=>({getAccessibleLineIds:mocks.access}))
vi.mock('@/lib/audit',()=>({audit:vi.fn()}))
vi.mock('@/lib/security-log',()=>({securityLog:vi.fn()}))
import {POST,GET} from '@/app/api/campaigns/route'
import {NextRequest,NextResponse} from 'next/server'
import {normalizeCampaignSchedule,validateCampaignTemplate} from '../campaign-template'
import {CreateCampaignSchema} from '../schema'
const owner='11111111-1111-4111-8111-111111111111', list='22222222-2222-4222-8222-222222222222',template='33333333-3333-4333-8333-333333333333'
const user={role:'operator',user_id:owner,is_super_admin:false}
const request=(body:unknown)=>new NextRequest('https://example.test/api/campaigns',{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}})
let templateRow:Record<string,unknown>, listOwner:string
beforeEach(()=>{
 vi.clearAllMocks();vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED','false');vi.stubEnv('CRON_SECRET','test-only')
 mocks.permission.mockResolvedValue({ok:true,user});mocks.access.mockResolvedValue([list]);listOwner=owner
 templateRow={name:'prueba',status:'APROBADA',waba_id:'12345',components:[{type:'BODY',text:'Hola {{1}}'}]}
 mocks.query.mockImplementation(async(sql:string)=>sql.includes('FROM whatsapp_templates WHERE')?[templateRow]:sql.includes('FROM cloud_numbers')?[{id:template}]:sql.includes('SELECT id, owned_by FROM prospect_lists')?[{id:list,owned_by:listOwner}]:sql.includes('SELECT owned_by FROM contact_lists')?[{owned_by:listOwner}]:sql.includes('COUNT(*)::int AS count')?[{count:1}]:sql.includes('INSERT INTO campaigns')?[{id:list}]:[])
})
afterEach(()=>vi.unstubAllEnvs())
describe('Campaign creation readiness',()=>{
 it('persists Cloud type, params and template without requiring free text',async()=>{
  const res=await POST(request({name:'Prueba',list_id:list,message_type:'template',template_id:template,template_params:{body:['Ana']},use_multi_line:false}))
  expect(res.status).toBe(200)
  const insert=mocks.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO campaigns'))!
  expect(insert[0]).toContain('message_type, template_id, template_params')
  expect(insert[1][14]).toBe(true);expect(insert[1].slice(-3)).toEqual(['template',template,JSON.stringify({body:['Ana']})])
 })
 it.each([{status:'BORRADOR'},{waba_id:null}])('rejects unverified template before insert %j',async patch=>{
  Object.assign(templateRow,patch)
  const res=await POST(request({name:'Prueba',message_type:'template',template_id:template,template_params:{body:['Ana']}}))
  expect(res.status).toBe(400);expect(mocks.query.mock.calls.some(([s])=>s.includes('INSERT'))).toBe(false)
 })
 it('rejects missing template values',async()=>{expect((await POST(request({name:'Prueba',message_type:'template',template_id:template}))).status).toBe(400)})
 it('checks ownership of prospect lists',async()=>{
  listOwner=template;expect((await POST(request({name:'Prueba',message:'Hola',prospect_list_id:list}))).status).toBe(403)
  expect(mocks.query.mock.calls.some(([s])=>s.includes('INSERT'))).toBe(false)
 })
 it('rejects whitespace and ambiguous text/template payload',async()=>{
  expect((await POST(request({name:'Prueba',message:'   '}))).status).toBe(400)
  expect((await POST(request({name:'Prueba',message:'Hola',message_type:'text',template_id:template}))).status).toBe(400)
 })
 it.each([{anti_ban_profile_id:template},{enable_mini_sessions:true},{daily_limit_override:50},{delay_type:'uniform'},{custom_delay_seconds:30}])('rejects options not applied by current processors: %j',async option=>{
  expect((await POST(request({name:'Prueba',message:'Hola',...option}))).status).toBe(400)
  expect(mocks.query.mock.calls.some(([s])=>s.includes('INSERT'))).toBe(false)
 })
 it('requires an audience before scheduling',async()=>{
  vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED','true')
  expect((await POST(request({name:'Prueba',message:'Hola',scheduled_at:'2030-01-01T12:00'}))).status).toBe(400)
 })
 it.each([{antiblock_delay_min:30,antiblock_delay_max:5},{antiblock_delay_max:301},{antiblock_delay_min:1.5},{antiblock_delay_min:1,antiblock_delay_max:2}])('rejects invalid pacing bounds: %j',async bounds=>{
  expect((await POST(request({name:'Prueba',message:'Hola',...bounds}))).status).toBe(400)
  expect(mocks.query.mock.calls.some(([s])=>s.includes('INSERT'))).toBe(false)
 })
 it('rejects scheduling when no automatic runner enabled',async()=>{
  expect((await POST(request({name:'Prueba',message:'Hola',list_id:list,scheduled_at:'2030-01-01T12:00'}))).status).toBe(409)
 })
 it('requires sending permission for scheduling',async()=>{
  vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED','true');mocks.permission.mockResolvedValueOnce({ok:true,user}).mockResolvedValueOnce({ok:false,response:NextResponse.json({error:'Forbidden'},{status:403})})
  expect((await POST(request({name:'Prueba',message:'Hola',list_id:list,scheduled_at:'2030-01-01T12:00'}))).status).toBe(403)
 })
 it('stores Argentina datetime-local as an instant',async()=>{
  vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED','true')
  expect((await POST(request({name:'Prueba',message:'Hola',list_id:list,scheduled_at:'2030-01-01T12:00'}))).status).toBe(200)
  expect(mocks.query.mock.calls.find(([s])=>s.includes('INSERT'))?.[1][9]).toBe('2030-01-01T15:00:00.000Z')
 })
 it('rejects past and invalid calendar dates',async()=>{
  vi.stubEnv('CAMPAIGN_SCHEDULER_ENABLED','true')
  for(const date of ['2020-01-01T12:00','2030-02-30T12:00','abc'])expect((await POST(request({name:'Prueba',message:'Hola',list_id:list,scheduled_at:date}))).status).toBe(400)
 })
 it('reports actual delivery only and exposes scheduler capability',async()=>{
  const res=await GET(new NextRequest('https://example.test/api/campaigns'))
  expect((await res.json()).scheduler_enabled).toBe(false)
  const sql=mocks.query.mock.calls[0][0]
  expect(sql).toContain("WHERE outcome IN ('delivered','read')")
  expect(sql).not.toContain("WHERE m.status IN ('sent','delivered','read')")
 })
})
describe('Template contract',()=>{
 it('does not strip template fields',()=>{const x=CreateCampaignSchema.parse({name:'X',message_type:'template',template_id:template,template_params:{body:['Ana']}});expect(x.template_params?.body).toEqual(['Ana'])})
 it('checks dynamic URL values and header type',()=>{
  const c=[{type:'BODY',text:'Hola'},{type:'HEADER',format:'IMAGE'},{type:'BUTTONS',buttons:[{type:'URL',url:'https://example.test/{{1}}'}]}]
  expect(validateCampaignTemplate(c,{})).toBeTruthy()
  expect(validateCampaignTemplate(c,{header:{type:'image',link:'https://example.test/pic.jpg'}})).toBeTruthy()
  expect(validateCampaignTemplate(c,{header:{type:'image',link:'https://example.test/pic.jpg'},buttons:[{index:0,sub_type:'url',payload:'abc'}]})).toBeNull()
 })
 it('refuses unsupported named vars and unexpected components',()=>{
  expect(validateCampaignTemplate([{type:'BODY',text:'Hola {{name}}'}],{body:['Ana']})).toBeTruthy()
  expect(validateCampaignTemplate([{type:'BODY',text:'Hola'},{type:'CAROUSEL'}],{})).toBeTruthy()
 })
 it('normalizes explicit and implicit Argentina time identically',()=>{expect(normalizeCampaignSchedule('2030-01-01T12:00')).toBe(normalizeCampaignSchedule('2030-01-01T12:00:00-03:00'))})
})
