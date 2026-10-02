// @vitest-environment node
import { beforeEach,it,expect,vi } from 'vitest'
const mocks=vi.hoisted(()=>({receive:vi.fn(),emit:vi.fn(),stop:vi.fn(),name:vi.fn()}))
vi.mock('@/lib/cloud-api/repositories/conversation.repository',()=>({conversationRepository:{receive:mocks.receive,updateContactDisplayName:mocks.name}}))
vi.mock('@/lib/cloud-api/repositories/compliance.repository',()=>({complianceRepository:{matchesStopKeyword:mocks.stop}}))
vi.mock('@/lib/cloud-api/infrastructure/metrics',()=>({cloudMetrics:{messageReceived:vi.fn()}}))
vi.mock('@/lib/cloud-api/infrastructure/logger',()=>({createLogger:()=>({logInfo:vi.fn()})}))
vi.mock('@/lib/sse-events',()=>({sseEmitter:{emit:mocks.emit}}))
vi.mock('@/lib/automation-engine',()=>({evaluateAutomations:vi.fn()}))
import { handleInboundMessage } from '../cloud-api/webhook-handlers/inbound-message.handler'
const msg={id:'wamid.test',from:'5491100000001',timestamp:'1700000000',type:'button' as const,button:{text:'Mas información',payload:'info'}}
beforeEach(()=>vi.resetAllMocks())
it('notifies Conversations only after the inbound message is durably stored',async()=>{
 let done!:()=>void;mocks.receive.mockImplementation(()=>new Promise<void>(r=>{done=r}))
 const pending=handleInboundMessage('10001',msg,[],'test')
 expect(mocks.emit).not.toHaveBeenCalled();done();await pending
 expect(mocks.emit).toHaveBeenCalledWith('update',{source:'message'})
})
it('does not notify when persistence fails and leaves the webhook retryable',async()=>{
 mocks.receive.mockRejectedValue(new Error('storage unavailable'))
 await expect(handleInboundMessage('10001',msg,[],'test')).rejects.toThrow('storage unavailable')
 expect(mocks.emit).not.toHaveBeenCalled()
})
