// @vitest-environment node
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { NextRequest } from 'next/server'
const mocks=vi.hoisted(()=>({record:vi.fn(),query:vi.fn(),receive:vi.fn(),stop:vi.fn(),optout:vi.fn(),automations:vi.fn()}))
vi.mock('@/lib/line-subscriptions',()=>({recordInboundSubscription:mocks.record}))
vi.mock('@/lib/db',()=>({query:mocks.query}))
vi.mock('@/lib/automation-engine',()=>({evaluateAutomations:mocks.automations}))
vi.mock('@/lib/automation-safety',()=>({recordHumanAutomationIntervention:vi.fn()}))
vi.mock('@/lib/opt-out-confirmation',()=>({sendOptOutConfirmation:vi.fn()}))
vi.mock('@/lib/global-opt-out',()=>({recordGlobalOptOut:mocks.optout}))
vi.mock('@/lib/notify',()=>({notify:vi.fn()}))
vi.mock('@/lib/cloud-api/repositories/conversation.repository',()=>({conversationRepository:{receive:mocks.receive,updateContactDisplayName:vi.fn()}}))
vi.mock('@/lib/cloud-api/repositories/compliance.repository',()=>({complianceRepository:{matchesStopKeyword:mocks.stop,recordOptOut:mocks.optout}}))
import { handleInboundMessage } from '@/lib/cloud-api/webhook-handlers/inbound-message.handler'
import { POST } from '@/app/api/webhook/evolution/route'
const message={id:'message-1',from:'5491112345678',timestamp:'1794945600',type:'text' as const,text:{body:'Quiero recibir novedades de Tienda por WhatsApp. BAJA.'}}
function evolution(fromMe=false,jid='5491112345678@s.whatsapp.net',secret='test-secret') {
  return new NextRequest('http://localhost/api/webhook/evolution',{method:'POST',headers:{'x-webhook-secret':secret},body:JSON.stringify({event:'messages.upsert',instance:'line-qr',data:{key:{id:message.id,fromMe,remoteJid:jid},messageTimestamp:Number(message.timestamp),message:{conversation:message.text.body}}})})
}
beforeEach(()=>{vi.resetAllMocks();mocks.record.mockResolvedValue(true);mocks.query.mockResolvedValue([]);mocks.stop.mockResolvedValue(false);vi.stubEnv('EVOLUTION_WEBHOOK_SECRET','test-secret')})
afterEach(()=>vi.unstubAllEnvs())
describe('inbound subscription wiring',()=>{
  it('records original Cloud message identity and time after persistence, without triggering marketing automation',async()=>{
    await handleInboundMessage('cloud-1',message,[],'test')
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({provider:'cloud',sourceId:'cloud-1',phone:'+'+message.from,text:message.text.body,messageId:message.id,timestamp:message.timestamp}))
    expect(mocks.receive.mock.invocationCallOrder[0]).toBeLessThan(mocks.record.mock.invocationCallOrder[0])
    expect(mocks.automations).not.toHaveBeenCalled();expect(mocks.optout).not.toHaveBeenCalled()
  })
  it('retains legacy Cloud opt-out handling on unconfigured lines',async()=>{
    mocks.record.mockResolvedValue(false)
    await handleInboundMessage('cloud-1',{...message,text:{body:'BAJA!'}},[],'test')
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({isStop:true}))
    expect(mocks.optout).toHaveBeenCalledOnce()
  })
  it('keeps the production opt-out even when subscription evidence was already recorded',async()=>{
    await handleInboundMessage('cloud-1',{...message,text:{body:'BAJA'}},[],'test')
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({isStop:true}))
    expect(mocks.optout).toHaveBeenCalledOnce()
    expect(mocks.automations).not.toHaveBeenCalled()
  })
  it('propagates storage errors so Cloud can retry instead of losing consent',async()=>{
    mocks.record.mockRejectedValue(new Error('DB offline'))
    await expect(handleInboundMessage('cloud-1',message,[],'test')).rejects.toThrow('DB offline')
    expect(mocks.automations).not.toHaveBeenCalled()
  })
  it('records direct Evolution inbound events under the actual instance',async()=>{
    expect((await POST(evolution())).status).toBe(200)
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({provider:'evolution',sourceId:'line-qr',phone:message.from,messageId:message.id,timestamp:Number(message.timestamp)}))
    expect(mocks.automations).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO blacklist'))).toBe(false)
  })
  it.each([[true,'5491112345678@s.whatsapp.net'],[false,'123@g.us'],[false,'status@broadcast'],[false,'123@lid']])('does not record outbound, group, broadcast or LID events (%s, %s)',async(fromMe,jid)=>{
    await POST(evolution(fromMe,jid))
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it('rejects invalid signatures before recording evidence',async()=>{
    expect((await POST(evolution(false,undefined,'wrong-secret'))).status).toBe(401)
    expect(mocks.record).not.toHaveBeenCalled()
  })
  it('returns a retryable status on Evolution storage failures',async()=>{
    mocks.record.mockRejectedValue(new Error('DB offline'))
    expect((await POST(evolution())).status).toBe(500)
  })
})
