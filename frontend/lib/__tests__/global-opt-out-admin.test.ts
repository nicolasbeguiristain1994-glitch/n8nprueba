// @vitest-environment node
import {beforeEach,it,expect,vi} from 'vitest'
import {NextRequest,NextResponse} from 'next/server'
const m=vi.hoisted(()=>({auth:vi.fn(),reinstate:vi.fn(),query:vi.fn(),canRead:vi.fn(),identity:vi.fn()}))
vi.mock('@/lib/permissions',()=>({checkPermissionWithUser:m.auth}))
vi.mock('@/lib/global-opt-out',()=>({reinstateGlobalContact:m.reinstate}))
vi.mock('@/lib/db',()=>({query:m.query}))
vi.mock('@/lib/audit',()=>({audit:vi.fn()}))
vi.mock('@/lib/sse-events',()=>({sseEmitter:{emit:vi.fn()},emitUpdate:vi.fn()}))
vi.mock('@/lib/conversation-access',()=>({canReadConversation:m.canRead,conversationPhone:(p:string)=>p}))
vi.mock('@/lib/consent-context',()=>({resolveConsentIdentity:m.identity}))
import {DELETE} from '@/app/api/blacklist/[id]/route'
import {PATCH} from '@/app/api/conversations/[phone]/blacklist/route'
const id='00000000-0000-4000-8000-000000000001',phone='5491100000001'
const request=(method:string,body?:object)=>new NextRequest('http://localhost/api/blacklist/'+id,{method,...(body?{body:JSON.stringify(body),headers:{'Content-Type':'application/json'}}:{})})
beforeEach(()=>{vi.clearAllMocks();m.auth.mockResolvedValue({ok:true,user:{user_id:id,role:'admin'}});m.reinstate.mockResolvedValue(true);m.query.mockResolvedValue([{id,scope_key:'agent:royal'}]);m.canRead.mockResolvedValue(true);m.identity.mockResolvedValue({agent:null})})
it('rejects removal without explicit new consent through both existing endpoints',async()=>{
  expect((await DELETE(request('DELETE'),{params:Promise.resolve({id})})).status).toBe(400)
  expect((await PATCH(request('PATCH'),{params:Promise.resolve({phone})})).status).toBe(400)
  expect(m.reinstate).not.toHaveBeenCalled()
})
it('records who reinstated the phone and the supplied consent evidence',async()=>{
  const body={consent_confirmed:true,consent_note:'Aceptó por WhatsApp el 13 de octubre'}
  expect((await DELETE(request('DELETE',body),{params:Promise.resolve({id})})).status).toBe(200)
  expect(m.auth).toHaveBeenCalledWith(expect.anything(),'blacklist','manage')
  expect(m.reinstate).toHaveBeenCalledWith(id,id,body.consent_note)
})
it('does not allow an operator to remove an opt-out even with consent fields',async()=>{
  m.auth.mockResolvedValue({ok:false,response:NextResponse.json({error:'Forbidden'},{status:403})})
  expect((await DELETE(request('DELETE',{consent_confirmed:true,consent_note:'Consintió recibir mensajes'}),{params:Promise.resolve({id})})).status).toBe(403)
  expect(m.reinstate).not.toHaveBeenCalled()
})

const consent={consent_confirmed:true,consent_note:'El contacto confirmó que la baja fue accidental',agent_code:'royal'}
it('reactivates only the explicit conversation agent for a shared phone',async()=>{
  const response=await PATCH(request('PATCH',consent),{params:Promise.resolve({phone})})
  expect(response.status).toBe(200)
  expect(m.query).toHaveBeenCalledWith(expect.stringContaining("scope_key='agent:'||$2"),[phone,'royal'])
  expect(m.reinstate).toHaveBeenCalledWith(id,id,consent.consent_note)
  expect(m.identity).not.toHaveBeenCalled()
})
it('preserves global blocks and rejects an unknown agent without any reinstatement',async()=>{
  m.query.mockResolvedValue([{id,scope_key:'global'}])
  expect((await PATCH(request('PATCH',consent),{params:Promise.resolve({phone})})).status).toBe(409)
  m.query.mockResolvedValue([])
  expect((await PATCH(request('PATCH',{...consent,agent_code:'unknown'}),{params:Promise.resolve({phone})})).status).toBe(404)
  expect(m.reinstate).not.toHaveBeenCalled()
})
it('rejects malformed or ambiguous agent scope and inaccessible conversations',async()=>{
  expect((await PATCH(request('PATCH',{...consent,agent_code:{}}),{params:Promise.resolve({phone})})).status).toBe(400)
  const {agent_code,...legacyConsent}=consent
  expect((await PATCH(request('PATCH',legacyConsent),{params:Promise.resolve({phone})})).status).toBe(409)
  m.canRead.mockResolvedValue(false)
  expect((await PATCH(request('PATCH',consent),{params:Promise.resolve({phone})})).status).toBe(403)
  expect(m.reinstate).not.toHaveBeenCalled()
})
it('rejects an operator through the conversation shortcut too',async()=>{
  m.auth.mockResolvedValue({ok:false,response:NextResponse.json({error:'Forbidden'},{status:403})})
  expect((await PATCH(request('PATCH',consent),{params:Promise.resolve({phone})})).status).toBe(403)
  expect(m.reinstate).not.toHaveBeenCalled()
})
