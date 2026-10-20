// @vitest-environment node
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
const mocks=vi.hoisted(()=>({query:vi.fn(),client:vi.fn(),evidence:vi.fn()}))
vi.mock('@/lib/db',()=>({query:mocks.query,getDbClient:mocks.client}))
vi.mock('@/lib/line-volume-data',()=>({getLineVolumeInputs:mocks.evidence}))
import {reserveLineSendBudget,finishLineSendBudget,LineSendBudgetError,LineSendAlreadyReservedError,deferCampaignForLineBudget,commercialCapacity} from '@/lib/line-send-budget'
import type {LineVolumeInput} from '@/lib/line-volume-policy'
const a='00000000-0000-4000-8000-000000000001',c='00000000-0000-4000-8000-000000000002'
const enabled=process.env.RUN_CAMPAIGN_PG_TESTS==='1'||!!process.env.OPS_TEST_DATABASE_URL

describe.skipIf(!enabled)('atomic line send budgets on local PostgreSQL',()=>{
 let db:Pool,admin:Pool
 const schema=`line_budget_${randomUUID().replaceAll('-','')}`
 let evidence:LineVolumeInput
 beforeAll(async()=>{
  const url=new URL(process.env.OPS_TEST_DATABASE_URL??process.env.DATABASE_URL!)
  if(!['localhost','127.0.0.1'].includes(url.hostname)||url.search)throw Error('LOCAL_ONLY')
  admin=new Pool({connectionString:url.toString(),ssl:false})
  await admin.query(`CREATE SCHEMA ${schema}`)
  db=new Pool({connectionString:url.toString(),ssl:false,max:12,options:`-c search_path=${schema},public`})
  await db.query(`CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY,respect_daily_recommendation boolean DEFAULT true,
   status text DEFAULT 'active',is_connected boolean DEFAULT true,sending_enabled boolean DEFAULT true,
   allowed_types jsonb DEFAULT '["campaign"]',msg_per_day int DEFAULT 100,msg_per_hour int DEFAULT 100,
   msgs_sent_today int DEFAULT 0,msgs_sent_hour int DEFAULT 0,day_reset_at timestamptz,hour_reset_at timestamptz,updated_at timestamptz);
   CREATE TABLE campaigns(id uuid PRIMARY KEY,status text DEFAULT 'running',pause_reason text,budget_resume_at timestamptz,updated_at timestamptz);`)
  const sql=readFileSync(new URL('../../../db/migrations/159_line_protection_controls.sql',import.meta.url),'utf8')
  await db.query(sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS line_campaign_daily_budgets'),sql.indexOf('-- The same business')))
  mocks.query.mockImplementation(async(sql,params)=>(await db.query(sql,params)).rows)
  mocks.client.mockImplementation(()=>db.connect())
 })
 beforeEach(async()=>{
  await db.query('TRUNCATE line_send_budget_reservations,line_campaign_daily_budgets,whatsapp_lines,campaigns CASCADE')
  await db.query('INSERT INTO whatsapp_lines(id) VALUES($1)',[a]);await db.query('INSERT INTO campaigns(id) VALUES($1)',[c])
  evidence={id:a,lineType:'cloud',status:'active',isConnected:true,sendingEnabled:true,campaignsAllowed:true,dailyLimit:100,hourlyLimit:100,
   dailyUsed:0,hourlyUsed:0,cloudStatus:'active',quality:'GREEN',lastMetaCheckAt:new Date().toISOString(),activeRiskReasons:[],recentDays:[],now:new Date().toISOString()}
  mocks.evidence.mockImplementation(async()=>[evidence])
 })
 afterAll(async()=>{if(db)await db.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()}})
 const reserve=(key:string=randomUUID(),purpose:'campaign'|'automation'='campaign')=>reserveLineSendBudget({lineId:a,purpose,sendKey:key})
 const counts=async()=>{const {rows:[l]}=await db.query('SELECT msgs_sent_today,msgs_sent_hour FROM whatsapp_lines WHERE id=$1',[a]);return l}
 it('keeps the 25-message recommendation atomic across concurrent campaigns',async()=>{
  const results=await Promise.allSettled(Array.from({length:40},()=>reserve()))
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(25)
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(15)
  expect(await counts()).toEqual({msgs_sent_today:25,msgs_sent_hour:25})
  expect((await db.query('SELECT consumed FROM line_campaign_daily_budgets')).rows).toEqual([{consumed:25}])
  for(const r of results)if(r.status==='rejected'){expect(r.reason).toBeInstanceOf(LineSendBudgetError);expect(r.reason.autoResume).toBe(true);expect(new Date(r.reason.retryAt).getUTCHours()).toBe(3)}
 })
 it('deduplicates the stable job key, including concurrent claims and after consumption',async()=>{
  const results=await Promise.allSettled([reserve('same','automation'),reserve('same','automation')])
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:expect.any(LineSendAlreadyReservedError)})
  const accepted=results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<{id:string}>
  await finishLineSendBudget(accepted.value.id,'consumed')
  await expect(reserve('same','automation')).rejects.toBeInstanceOf(LineSendAlreadyReservedError)
  expect(await counts()).toEqual({msgs_sent_today:1,msgs_sent_hour:1})
 })
 it('refunds a definite no-send once and safely allows its same key to reserve again',async()=>{
  const reservation=await reserve('preflight')
  await Promise.all([finishLineSendBudget(reservation.id,'no_send'),finishLineSendBudget(reservation.id,'no_send')])
  expect(await counts()).toEqual({msgs_sent_today:0,msgs_sent_hour:0})
  expect((await db.query('SELECT consumed FROM line_campaign_daily_budgets')).rows[0].consumed).toBe(0)
  expect(await reserve('preflight')).toEqual(reservation)
  expect(await counts()).toEqual({msgs_sent_today:1,msgs_sent_hour:1})
 })
 it('never refunds a consumed/uncertain attempt after a later cleanup',async()=>{
  const reservation=await reserve();await finishLineSendBudget(reservation.id,'consumed');await finishLineSendBudget(reservation.id,'no_send')
  expect(await counts()).toEqual({msgs_sent_today:1,msgs_sent_hour:1})
 })
 it('does not refund a previous reservation into a new rolling counter window',async()=>{
  const reservation=await reserve()
  await db.query("UPDATE whatsapp_lines SET msgs_sent_today=7,msgs_sent_hour=3,day_reset_at=now()+interval '2 days',hour_reset_at=now()+interval '2 hours'")
  await finishLineSendBudget(reservation.id,'no_send')
  expect(await counts()).toEqual({msgs_sent_today:7,msgs_sent_hour:3})
 })
 it('reserves20% for service while automations can use the complete configured quota',async()=>{
  await db.query('UPDATE whatsapp_lines SET msg_per_day=10,msg_per_hour=10')
  for(let i=0;i<8;i++)await reserve()
  await expect(reserve()).rejects.toMatchObject({reason:'capacity_exhausted',autoResume:true})
  await reserve('reply1','automation');await reserve('reply2','automation')
  await expect(reserve('reply3','automation')).rejects.toMatchObject({reason:'capacity_exhausted',autoResume:false})
  expect(await counts()).toEqual({msgs_sent_today:10,msgs_sent_hour:10})
 })
 it('uses the later exhausted rolling window without a busy retry loop',async()=>{
  await db.query("UPDATE whatsapp_lines SET msg_per_day=10,msg_per_hour=10,msgs_sent_today=8,msgs_sent_hour=8,day_reset_at=now()+interval '10 hours',hour_reset_at=now()+interval '20 minutes'")
  try{await reserve();throw Error('expected budget error')}catch(e){expect(e).toBeInstanceOf(LineSendBudgetError);expect(new Date((e as LineSendBudgetError).retryAt).getTime()-Date.now()).toBeGreaterThan(9*3600_000)}
 })
 it('seeds existing campaign history once; reservations cover in-flight messages without double counting',async()=>{
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
  evidence.recentDays=[{date,attempted:23,accepted:23,delivered:23,failed:0,ecosystemRejected:0,optOuts:0,lastSentAt:new Date().toISOString()}]
  await reserve();evidence.recentDays[0].attempted=24;await reserve()
  await expect(reserve()).rejects.toBeInstanceOf(LineSendBudgetError)
  expect((await db.query('SELECT consumed FROM line_campaign_daily_budgets')).rows[0].consumed).toBe(25)
  expect(await counts()).toEqual({msgs_sent_today:2,msgs_sent_hour:2})
 })
 it('fails closed on missing evidence, stale Meta, or stored risk without consuming quota',async()=>{
  mocks.evidence.mockRejectedValueOnce(Error('database unavailable'))
  await expect(reserve()).rejects.toMatchObject({reason:'budget_check_unavailable',autoResume:true})
  evidence.lastMetaCheckAt='2020-01-01T00:00:00Z';await expect(reserve()).rejects.toMatchObject({reason:'recommendation_unavailable'})
  evidence.lastMetaCheckAt=new Date().toISOString();evidence.activeRiskReasons=['risk']
  await expect(reserve()).rejects.toMatchObject({reason:'recommendation_unavailable'})
  expect(await counts()).toEqual({msgs_sent_today:0,msgs_sent_hour:0})
 })
 it('does not read campaign evidence for service or lines that did not opt in',async()=>{
  mocks.evidence.mockClear();await reserve('service','automation')
  await db.query('UPDATE whatsapp_lines SET respect_daily_recommendation=false,msg_per_day=2,msg_per_hour=2')
  await reserve();await expect(reserve()).rejects.toMatchObject({autoResume:false})
  expect(mocks.evidence).not.toHaveBeenCalled()
 })
 it('projects expired counters atomically and initializes their new deadlines',async()=>{
  await db.query("UPDATE whatsapp_lines SET msgs_sent_today=100,msgs_sent_hour=100,day_reset_at=now()-interval '1 second',hour_reset_at=now()-interval '1 second'")
  await reserve();expect(await counts()).toEqual({msgs_sent_today:1,msgs_sent_hour:1})
 })
 it('cannot auto-resume a manual/risk pause and schedules only opted-in budget waits',async()=>{
  const e=new LineSendBudgetError('capacity_exhausted',new Date(Date.now()+3600_000).toISOString(),true)
  await deferCampaignForLineBudget(c,e)
  expect((await db.query('SELECT status,pause_reason,budget_resume_at IS NOT NULL AS scheduled FROM campaigns')).rows[0]).toEqual({status:'paused',pause_reason:'line_budget',scheduled:true})
  for(const reason of ['risk_detected','manual']){
   await db.query("UPDATE campaigns SET status='paused',pause_reason=$1,budget_resume_at=NULL",[reason]);await deferCampaignForLineBudget(c,e)
   expect((await db.query('SELECT pause_reason,budget_resume_at FROM campaigns')).rows[0]).toEqual({pause_reason:reason,budget_resume_at:null})
  }
  await db.query("UPDATE campaigns SET status='running',pause_reason=NULL")
  await deferCampaignForLineBudget(c,new LineSendBudgetError('capacity_exhausted',e.retryAt,false))
  expect((await db.query('SELECT pause_reason,budget_resume_at FROM campaigns')).rows[0]).toEqual({pause_reason:'no_eligible_lines',budget_resume_at:null})
 })
})
it('keeps one-message configurations usable and reserves at least one service slot otherwise',()=>{
 expect([0,1,2,3,10,11].map(commercialCapacity)).toEqual([0,1,1,2,8,8])
})
