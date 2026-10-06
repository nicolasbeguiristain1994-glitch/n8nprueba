// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
const db = vi.hoisted(()=>({query:vi.fn()}))
vi.mock('@/lib/db',()=>({withTransaction:vi.fn(async fn=>fn(db)),query:vi.fn()}))
import { connectDirectNumber, validateCloudAssets, DirectConnectionSchema } from '../cloud-api/connection'
import { withTransaction } from '../db'
const token='test-token-do-not-log-123456789'
const input={appId:'12345',wabaId:'23456',phoneNumberId:'34567',accessToken:token,register:false}
const fetchMock=vi.fn()
beforeEach(()=>{
  vi.stubEnv('META_ADDITIONAL_APPS_JSON','')
  vi.stubEnv('META_APP_ID','12345');vi.stubEnv('META_APP_SECRET','test-secret');vi.stubEnv('TOKEN_ENCRYPTION_KEY','a'.repeat(32));vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN','verify-test')
  vi.stubGlobal('fetch',fetchMock);fetchMock.mockReset();db.query.mockReset();vi.mocked(withTransaction).mockClear()
  db.query.mockImplementation(async(sql:string)=>({rows:sql.includes('RETURNING id')?[{id:'saved-id'}]:[]}))
})
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs()})
function meta(overrides:Record<string,unknown>={}) {
  fetchMock.mockImplementation(async(url:string)=>new Response(JSON.stringify(
    url.includes('debug_token')?{data:{is_valid:true,app_id:'12345',scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0,...overrides}}:
    url.includes('phone_numbers')?{data:[{id:'34567'}]}:
    url.includes('?fields=')?{id:'34567',display_phone_number:'+5491100000000',verified_name:'Prueba',code_verification_status:'VERIFIED',platform_type:'CLOUD_API',status:'CONNECTED'}:{success:true}
  ),{status:200}))
}
describe('Direct Cloud connection',()=>{
  it('validates and connects an additional app using only its own app secret',async()=>{
    vi.stubEnv('META_ADDITIONAL_APPS_JSON',JSON.stringify([{appId:'98765',name:'Nexus',appSecret:'nexus-secret-test',verifyToken:'nexus-verify-test',wabaIds:['23456']}]))
    meta({app_id:'98765'})
    const result=await connectDirectNumber({...input,appId:'98765'},'bootstrap')
    expect(result.status).toBe('active')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer 98765|nexus-secret-test')
  })
  it.each([['12345','23456'],['98765','87654']])('rejects a cross-app WABA before contacting Meta: %s %s',async(appId,wabaId)=>{
    vi.stubEnv('META_ADDITIONAL_APPS_JSON',JSON.stringify([{appId:'98765',name:'Nexus',appSecret:'nexus-secret-test',verifyToken:'nexus-verify-test',wabaIds:['23456']}]))
    await expect(connectDirectNumber({...input,appId,wabaId},'bootstrap')).rejects.toThrow('no está asignada')
    expect(fetchMock).not.toHaveBeenCalled();expect(withTransaction).not.toHaveBeenCalled()
  })
  it('does not accept a legacy token for an additional app',async()=>{
    vi.stubEnv('META_ADDITIONAL_APPS_JSON',JSON.stringify([{appId:'98765',name:'Nexus',appSecret:'nexus-secret-test',verifyToken:'nexus-verify-test',wabaIds:['23456']}]))
    meta()
    await expect(connectDirectNumber({...input,appId:'98765'},'bootstrap')).rejects.toThrow('otra aplicación')
    expect(withTransaction).not.toHaveBeenCalled()
  })
  it('validates assets before storing an encrypted token, with campaign sending disabled',async()=>{
    meta();const result=await connectDirectNumber(input,'bootstrap')
    expect(result.status).toBe('active');expect(JSON.stringify(result)).not.toContain(token)
    expect(db.query.mock.calls.find(c=>c[0].includes('INSERT INTO cloud_numbers'))?.[0]).toContain('pgp_sym_encrypt')
    expect(db.query.mock.calls.find(c=>c[0].includes('INSERT INTO whatsapp_lines'))?.[0]).toContain('true,false')
    expect(fetchMock.mock.calls.some(c=>c[0].includes('/register'))).toBe(false)
  })
  it.each([{is_valid:false},{app_id:'99999'},{scopes:['whatsapp_business_management']},{expires_at:1}])('rejects unusable tokens before writes: %j',async override=>{
    meta(override);await expect(connectDirectNumber(input,'bootstrap')).rejects.toThrow();expect(withTransaction).not.toHaveBeenCalled()
  })
  it('rejects a phone outside the selected WABA',async()=>{
    meta();await expect(validateCloudAssets(token,'12345','23456','99999')).rejects.toThrow('no pertenece');expect(withTransaction).not.toHaveBeenCalled()
  })
  it('requires an explicit six-digit PIN for registration',()=>{
    expect(DirectConnectionSchema.safeParse({...input,register:true}).success).toBe(false)
    expect(DirectConnectionSchema.safeParse({...input,register:true,pin:'123456'}).success).toBe(true)
  })
  it('does not mark an unregistered verified number active',async()=>{
    meta();const initial=fetchMock.getMockImplementation()!;fetchMock.mockImplementation(async(url:string)=>url.includes('/34567?fields=')?new Response(JSON.stringify({code_verification_status:'VERIFIED',platform_type:'CLOUD_API',status:'PENDING'})):initial(url))
    await expect(connectDirectNumber(input,'bootstrap')).rejects.toThrow('todavía no');expect(withTransaction).not.toHaveBeenCalled()
  })
})
