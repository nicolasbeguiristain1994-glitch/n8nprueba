// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn(),auth:vi.fn(),visibility:vi.fn()}))
vi.mock('@/lib/db',()=>({query:mocks.query,withTransaction:mocks.transaction}))
vi.mock('@/lib/permissions',()=>({checkPermissionWithUser:mocks.auth}))
vi.mock('@/lib/line-visibility',()=>({getAccessibleLineIds:mocks.visibility}))
vi.mock('@/lib/audit',()=>({audit:vi.fn()}))
import { recordInboundSubscription, saveSubscriptionSettings, assertLineSubscription, assertProviderSubscription, type InboundSubscriptionMessage } from '@/lib/line-subscriptions'
import { GET, PUT } from '@/app/api/lines/subscriptions/route'
import { SUBSCRIPTION_PRESETS,defaultSubscriptionFlow } from '@/lib/line-subscription-message'

const A='00000000-0000-4000-8000-000000000001', B='00000000-0000-4000-8000-000000000002', U='00000000-0000-4000-8000-000000000099'
const phone='5491112345678'
const clothing=SUBSCRIPTION_PRESETS.clothing.replace('{marca}','Tienda')
const solar=SUBSCRIPTION_PRESETS.solar.replace('{marca}','Solar')
const time=Math.floor(Date.now()/1000)-3600
const inbound=(overrides:Partial<InboundSubscriptionMessage>={}):InboundSubscriptionMessage=>({provider:'cloud',sourceId:'cloud-1',phone,text:clothing,messageId:'in-1',timestamp:time,...overrides})
const req=(path='',method='GET',body?:unknown)=>new NextRequest('http://localhost/api/lines/subscriptions'+path,{method,...(body?{body:JSON.stringify(body),headers:{'Content-Type':'application/json'}}:{})})

describe.skipIf(!(process.env.TEST_LINE_SUBSCRIPTIONS_DB_URL || process.env.OPS_TEST_DATABASE_URL))('line subscriptions on real PostgreSQL',()=>{
  let pool:Pool
  const schema=`subscription_test_${process.pid}`
  beforeAll(async()=>{
    const url=new URL((process.env.TEST_LINE_SUBSCRIPTIONS_DB_URL || process.env.OPS_TEST_DATABASE_URL)!)
    if (!['127.0.0.1','localhost'].includes(url.hostname)) throw Error('LOCAL_ONLY')
    pool=new Pool({connectionString:url.toString(),ssl:false,options:`-c search_path=${schema}`})
    await pool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE whatsapp_lines(id uuid PRIMARY KEY,line_key text,display_name text,phone_number text,line_type text,evolution_instance text,owner_user_id uuid);
      CREATE TABLE cloud_numbers(whatsapp_line_id uuid,phone_number_id text,display_phone text);
      CREATE TABLE cloud_opt_outs(contact_phone text,phone_number_id text,opted_out boolean,opted_out_at timestamptz,reason text,PRIMARY KEY(contact_phone,phone_number_id));`)
    const migration=readFileSync('../db/migrations/166_line_subscriptions.sql','utf8')
    await pool.query(migration);await pool.query(migration)
    await pool.query(readFileSync('../db/migrations/167_subscription_confirmation.sql','utf8'))
    mocks.query.mockImplementation(async(sql,args)=>(await pool.query(sql,args)).rows)
    mocks.transaction.mockImplementation(async fn=>{
      const client=await pool.connect()
      try {await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result}
      catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
    })
  })
  afterAll(async()=>{if(pool){await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()}})
  beforeEach(async()=>{
    await pool.query('TRUNCATE whatsapp_lines,cloud_numbers,cloud_opt_outs CASCADE')
    await pool.query(`INSERT INTO whatsapp_lines VALUES($1,'a','Tienda','5491100000001','cloud',NULL,$3),($2,'b','Solar','5491100000002','evolution','solar-instance',$3)`,[A,B,U])
    await pool.query(`INSERT INTO cloud_numbers VALUES($1,'cloud-1','+5491100000001')`,[A])
    await saveSubscriptionSettings(A,'Tienda',clothing,true)
    await saveSubscriptionSettings(B,'Solar',solar,true)
    await pool.query("UPDATE whatsapp_subscription_settings SET active_since=NOW()-INTERVAL '1 day'")
    mocks.auth.mockResolvedValue({ok:true,user:{user_id:U,role:'admin',is_super_admin:true}})
    mocks.visibility.mockResolvedValue(null)
  })
  it('records actual evidence once under concurrent delivery and grants only the receiving line',async()=>{
    const received='  '+clothing.toUpperCase().replaceAll(' ','  ')+'  '
    expect(await Promise.all(Array.from({length:6},()=>recordInboundSubscription(inbound({text:received}))))).toEqual(Array(6).fill(true))
    const rows=(await pool.query('SELECT * FROM whatsapp_subscription_events')).rows
    expect(rows).toHaveLength(1);expect(rows[0].message_text).toBe(received)
    expect(rows[0].expected_message).toBe(clothing)
    await expect(assertLineSubscription(A,'+'+phone)).resolves.toBeUndefined()
    await expect(assertLineSubscription(B,phone)).rejects.toThrow('todavía no autorizó')
    await expect(assertProviderSubscription('cloud','cloud-1',phone,true)).resolves.toBeUndefined()
  })
  it('does not subscribe from a greeting, wrong line, old text, missing timestamp or unknown source',async()=>{
    for(const patch of [{text:'Hola'},{text:clothing.slice(0,25)},{provider:'evolution',sourceId:'solar-instance'},{sourceId:'unknown'},{timestamp:undefined},{timestamp:time-172800}] as Partial<InboundSubscriptionMessage>[])
      expect(await recordInboundSubscription(inbound(patch))).toBe(false)
    expect((await pool.query('SELECT * FROM whatsapp_subscription_events')).rows).toHaveLength(0)
  })
  it('honors BAJA and re-subscription while resisting delayed and repeated webhooks',async()=>{
    await recordInboundSubscription(inbound())
    await recordInboundSubscription(inbound({text:' baja! ',messageId:'out',timestamp:time+30}))
    await recordInboundSubscription(inbound())
    await recordInboundSubscription(inbound({messageId:'late-optin',timestamp:time+10}))
    await expect(assertLineSubscription(A,phone)).rejects.toThrow('BAJA')
    await recordInboundSubscription(inbound({messageId:'rejoin',timestamp:time+60}))
    await recordInboundSubscription(inbound({text:'BAJA',messageId:'late-stop',timestamp:time+40}))
    await expect(assertLineSubscription(A,phone)).resolves.toBeUndefined()
  })
  it('gives BAJA priority on equal provider timestamps',async()=>{
    await recordInboundSubscription(inbound({text:'BAJA',messageId:'stop-first'}))
    await recordInboundSubscription(inbound())
    await expect(assertLineSubscription(A,phone)).rejects.toThrow('BAJA')
  })
  it('rolls back evidence and state together if the subscription state cannot be updated',async()=>{
    await pool.query("ALTER TABLE whatsapp_line_subscribers ADD CONSTRAINT simulate_storage_failure CHECK(status <> 'unsubscribed')")
    try {
      await expect(recordInboundSubscription(inbound({text:'BAJA'}))).rejects.toThrow()
      expect((await pool.query('SELECT * FROM whatsapp_subscription_events')).rows).toHaveLength(0)
      expect((await pool.query('SELECT * FROM whatsapp_line_subscribers')).rows).toHaveLength(0)
    } finally {await pool.query('ALTER TABLE whatsapp_line_subscribers DROP CONSTRAINT simulate_storage_failure')}
    expect(await recordInboundSubscription(inbound({text:'BAJA'}))).toBe(true)
    await expect(assertLineSubscription(A,phone)).rejects.toThrow('BAJA')
  })
  it('handles QR consent and BAJA without granting or revoking another line',async()=>{
    await recordInboundSubscription(inbound())
    await recordInboundSubscription(inbound({provider:'evolution',sourceId:'solar-instance',text:solar}))
    await recordInboundSubscription(inbound({provider:'evolution',sourceId:'solar-instance',text:'BAJA',messageId:'stop',timestamp:time+1}))
    await expect(assertLineSubscription(B,phone)).rejects.toThrow('BAJA')
    await expect(assertLineSubscription(A,phone)).resolves.toBeUndefined()
  })
  it('keeps opt-out protection when capture is disabled and handles a malformed BAJA timestamp',async()=>{
    await saveSubscriptionSettings(A,'Tienda',clothing,false)
    expect(await recordInboundSubscription(inbound())).toBe(false)
    expect(await recordInboundSubscription(inbound({text:'BAJA',timestamp:'invalid'}))).toBe(true)
    await expect(assertLineSubscription(A,phone,false)).rejects.toThrow('BAJA')
  })
  it('does not lift an existing manual/policy restriction',async()=>{
    await pool.query(`INSERT INTO cloud_opt_outs VALUES($1,'cloud-1',true,NOW(),'policy_violation')`,['+'+phone])
    await recordInboundSubscription(inbound())
    expect((await pool.query('SELECT opted_out,reason FROM cloud_opt_outs')).rows[0]).toEqual({opted_out:true,reason:'policy_violation'})
  })
  it('requires renewed consent for changed terms and preserves old evidence',async()=>{
    await recordInboundSubscription(inbound())
    const changed=clothing.replace('2 veces','1 vez')
    await saveSubscriptionSettings(A,'Tienda',changed,true)
    await expect(assertLineSubscription(A,phone)).rejects.toThrow('todavía no autorizó')
    expect(await recordInboundSubscription(inbound({messageId:'old-link',timestamp:Math.floor(Date.now()/1000)+1}))).toBe(false)
    const result=await (await GET(req('?lineId='+A))).json()
    expect(result.stats).toEqual({subscribed:0,unsubscribed:0,pending:0,renewal_required:1})
    expect(result.records[0]).toMatchObject({status:'renewal_required',message_text:clothing})
    await recordInboundSubscription(inbound({text:changed,messageId:'new-link',timestamp:Math.floor(Date.now()/1000)+2}))
    await expect(assertLineSubscription(A,phone)).resolves.toBeUndefined()
  })
  it('leaves unconfigured lines unchanged and permits service replies before an opt-in',async()=>{
    await expect(assertLineSubscription(A,phone,false)).resolves.toBeUndefined()
    await pool.query('DELETE FROM whatsapp_subscription_settings WHERE line_id=$1',[B])
    await expect(assertLineSubscription(B,phone)).resolves.toBeUndefined()
  })
  it('serves links without writing consent and persists validated line-specific copy',async()=>{
    const response=await GET(req('?lineId='+A))
    expect(response.status).toBe(200)
    const data=await response.json()
    expect(new URL(data.link).searchParams.get('text')).toBe(clothing)
    expect(data.records).toEqual([])
    expect((await pool.query('SELECT * FROM whatsapp_line_subscribers')).rows).toHaveLength(0)
    const updated=await PUT(req('','PUT',{lineId:B,brandName:'Solar',message:solar,enabled:false}))
    expect(updated.status).toBe(200);expect((await updated.json()).link).toBeNull()
  })
  it('accepts the screenshot wording through the API and records consent only for the receiving line',async()=>{
    const message='Quiero recibir promociones de tu Negocio por Whatsapp. Puedo cancelar escribiendo BAJA.'
    const saved=await PUT(req('','PUT',{lineId:A,brandName:'Commando BD',message,enabled:true}))
    expect(saved.status).toBe(200)
    expect(new URL((await saved.json()).link).searchParams.get('text')).toBe(message)
    expect(await recordInboundSubscription(inbound({text:message,timestamp:Math.floor(Date.now()/1000)+1}))).toBe(true)
    await expect(assertLineSubscription(A,phone)).resolves.toBeUndefined()
    await expect(assertLineSubscription(B,phone)).rejects.toThrow('todavía no autorizó')
    const record=(await(await GET(req('?lineId='+A))).json()).records[0]
    expect(record).toMatchObject({brand_name:'Commando BD',message_text:message,expected_message:message,status:'subscribed'})
  })
  it('stores the confirmation flow through the scoped API, rejects QR and preserves it for older clients',async()=>{
    const flow=defaultSubscriptionFlow('Tienda')
    const response=await PUT(req('','PUT',{lineId:A,brandName:'Tienda',message:clothing,enabled:true,confirmationFlow:flow}))
    expect(response.status).toBe(200)
    const config=(await response.json()).settings
    expect(config.confirmation_flow).toEqual(flow)
    const legacy=await PUT(req('','PUT',{lineId:A,brandName:'Tienda',message:clothing,enabled:true}))
    expect((await legacy.json()).settings).toMatchObject({confirmation_flow:flow,revision:config.revision})
    const qr=await PUT(req('','PUT',{lineId:B,brandName:'Solar',message:solar,enabled:true,confirmationFlow:flow}))
    expect(qr.status).toBe(400)
    const invalid=await PUT(req('','PUT',{lineId:A,brandName:'Tienda',message:clothing,enabled:true,confirmationFlow:{...flow,welcome:'Hola'}}))
    expect(invalid.status).toBe(400)
    const disabled=await PUT(req('','PUT',{lineId:A,brandName:'Tienda',message:clothing,enabled:true,confirmationFlow:null}))
    expect((await disabled.json()).settings.confirmation_flow).toBeNull()
  })
  it('scopes reading and writing to visible lines and rejects a granted operator edit',async()=>{
    mocks.visibility.mockResolvedValue([A])
    expect((await GET(req('?lineId='+B))).status).toBe(404)
    expect((await PUT(req('','PUT',{lineId:B,brandName:'Solar',message:solar,enabled:true}))).status).toBe(404)
    expect((await (await GET(req())).json()).lines.map((l:{id:string})=>l.id)).toEqual([A])
    mocks.auth.mockResolvedValue({ok:true,user:{user_id:A,role:'operator'}})
    expect((await PUT(req('','PUT',{lineId:A,brandName:'Tienda',message:clothing,enabled:true}))).status).toBe(403)
    mocks.auth.mockResolvedValue({ok:false,response:Response.json({error:'Forbidden'},{status:403})})
    expect((await GET(req())).status).toBe(403)
  })
  it('validates requests and paginates history without cross-line evidence',async()=>{
    expect((await GET(req('?lineId=invalid'))).status).toBe(400)
    expect((await GET(req('?lineId='+A+'&page=-1'))).status).toBe(400)
    expect((await PUT(req('','PUT',{lineId:A,brandName:'Tienda',message:'Hola',enabled:true}))).status).toBe(400)
    for(let n=0;n<52;n++) await recordInboundSubscription(inbound({messageId:'event-'+n,timestamp:time+n}))
    const first=await(await GET(req('?lineId='+A+'&view=history'))).json()
    const second=await(await GET(req('?lineId='+A+'&view=history&page=1'))).json()
    expect(first.records).toHaveLength(50);expect(first.hasMore).toBe(true)
    expect(second.records).toHaveLength(2);expect(second.hasMore).toBe(false)
    expect(new Set([...first.records,...second.records].map(r=>r.id)).size).toBe(52)
    expect((await(await GET(req('?lineId='+B+'&view=history'))).json()).records).toHaveLength(0)
  })
})
