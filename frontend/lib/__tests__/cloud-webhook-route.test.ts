// @vitest-environment node
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { createHmac } from 'crypto'
import { NextRequest } from 'next/server'
const mocks=vi.hoisted(()=>({inbound:vi.fn(),status:vi.fn(),echo:vi.fn(),template:vi.fn(),sync:vi.fn(),find:vi.fn(),query:vi.fn()}))
vi.mock('@/lib/db',()=>({query:mocks.query}))
vi.mock('@/lib/cloud-api/repositories/cloud-number.repository',()=>({cloudNumberRepository:{findByPhoneNumberId:mocks.find}}))
vi.mock('@/lib/cloud-api/webhook-handlers/inbound-message.handler',()=>({handleInboundMessage:mocks.inbound}))
vi.mock('@/lib/cloud-api/webhook-handlers/delivery-status.handler',()=>({handleDeliveryStatus:mocks.status}))
vi.mock('@/lib/cloud-api/webhook-handlers/echo-message.handler',()=>({handleEchoMessage:mocks.echo}))
vi.mock('@/lib/cloud-api/webhook-handlers/template-status.handler',()=>({handleTemplateStatusUpdate:mocks.template}))
vi.mock('@/lib/cloud-api/webhook-handlers/coexistence-sync.handler',()=>({handleCoexistenceSyncEvent:mocks.sync}))
import { POST, GET } from '@/app/api/cloud/webhook/route'
const message={id:'wamid.test',from:'5491100000000',timestamp:'1780000000',type:'text',text:{body:'Hola'}}
const change={field:'messages',value:{metadata:{phone_number_id:'34567'},messages:[message]}}
function request(changes:unknown[]=[change],signature=true,waba='23456'){
 const body=JSON.stringify({object:'whatsapp_business_account',entry:[{id:waba,changes}]})
 return new NextRequest('https://panel.test/api/cloud/webhook',{method:'POST',body,headers:{'x-hub-signature-256':signature?'sha256='+createHmac('sha256','secret-test').update(body).digest('hex'):'sha256=bad'}})
}
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('META_APP_SECRET','secret-test');mocks.find.mockResolvedValue({wabaId:'23456'});mocks.query.mockResolvedValue([])})
afterEach(()=>vi.unstubAllEnvs())
it('rejects unsigned events without dispatching',async()=>{expect((await POST(request([change],false))).status).toBe(401);expect(mocks.inbound).not.toHaveBeenCalled()})
it('processes template updates without phone metadata',async()=>{expect((await POST(request([{field:'message_template_status_update',value:{message_template_id:'42',event:'APPROVED'}}]))).status).toBe(200);expect(mocks.template).toHaveBeenCalledTimes(1)})
it('returns 503 on persistence failure so Meta retries',async()=>{mocks.inbound.mockRejectedValue(new Error('DB unavailable'));expect((await POST(request())).status).toBe(503)})
it('does not acknowledge before the message is stored',async()=>{
 let resolve!:()=>void;mocks.inbound.mockImplementation(()=>new Promise<void>(r=>{resolve=r}));let done=false
 const pending=POST(request()).then(r=>{done=true;return r});await vi.waitFor(()=>expect(mocks.inbound).toHaveBeenCalled());expect(done).toBe(false);resolve();expect((await pending).status).toBe(200)
})
it('ignores a phone from another WABA',async()=>{expect((await POST(request([change],true,'other'))).status).toBe(200);expect(mocks.inbound).not.toHaveBeenCalled();expect(mocks.query).not.toHaveBeenCalled()})
it('rejects verification when no secret is configured',async()=>{vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN','');expect((await GET(new NextRequest('https://panel.test/api/cloud/webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=123'))).status).toBe(403)})
it('echo events never dispatch as inbound messages',async()=>{expect((await POST(request([{field:'smb_message_echoes',value:{metadata:{phone_number_id:'34567'},message_echoes:[{...message,to:'5491100000001'}]}}]))).status).toBe(200);expect(mocks.echo).toHaveBeenCalledTimes(1);expect(mocks.inbound).not.toHaveBeenCalled()})
