// @vitest-environment node
import {beforeEach,it,expect,vi} from 'vitest'
const m=vi.hoisted(()=>({receive:vi.fn(),record:vi.fn(),stop:vi.fn(),automation:vi.fn(),emit:vi.fn(),confirm:vi.fn()}))
vi.mock('@/lib/opt-out-confirmation',()=>({sendOptOutConfirmation:m.confirm}))
vi.mock('@/lib/cloud-api/repositories/conversation.repository',()=>({conversationRepository:{receive:m.receive,updateContactDisplayName:vi.fn()}}))
vi.mock('@/lib/cloud-api/repositories/compliance.repository',()=>({complianceRepository:{recordOptOut:m.record,matchesStopKeyword:m.stop}}))
vi.mock('@/lib/automation-engine',()=>({evaluateAutomations:m.automation}))
vi.mock('@/lib/sse-events',()=>({sseEmitter:{emit:m.emit}}))
vi.mock('@/lib/cloud-api/infrastructure/metrics',()=>({cloudMetrics:{messageReceived:vi.fn(),optOut:vi.fn()}}))
import {handleInboundMessage} from '@/lib/cloud-api/webhook-handlers/inbound-message.handler'
import {evolutionOptOutCandidates} from '@/lib/opt-out-command'
import type {WebhookMessage} from '@/lib/cloud-api/types/webhooks'
const base={from:'5491100000001',id:'baja-event',timestamp:'1791830000'}
beforeEach(()=>{vi.clearAllMocks();m.record.mockReset();m.stop.mockImplementation(async(text:string)=>text.trim().toUpperCase()==='BAJA')})
it.each([
  {type:'button',button:{text:'BAJA',payload:'custom-reply-2'}},
  {type:'button',button:{text:'Salir',payload:'BAJA'}},
  {type:'interactive',interactive:{type:'button_reply',button_reply:{id:'choice-2',title:'BAJA'}}},
  {type:'text',text:{body:'  baja  '}},
])('persists an explicit stop before acknowledging and never runs an automation: %j',async(content)=>{
  await handleInboundMessage('line-4',{...base,...content} as WebhookMessage,[],'test')
  expect(m.record).toHaveBeenCalledOnce();expect(m.record).toHaveBeenCalledWith(expect.objectContaining({phone:'+5491100000001',phoneNumberId:'line-4',wamid:'baja-event'}))
  expect(m.automation).not.toHaveBeenCalled()
  expect(m.confirm).toHaveBeenCalledWith({phone:'+5491100000001',sourceId:'line-4',messageId:'baja-event',provider:'cloud'})
  expect(m.record.mock.invocationCallOrder[0]).toBeLessThan(m.confirm.mock.invocationCallOrder[0])
})
it.each([
  {type:'text',text:{body:'¿Cómo funciona la baja?'}},
  {type:'image',image:{id:'image',mime_type:'image/png',sha256:'a',caption:'BAJA'}},
  {type:'document',document:{id:'doc',mime_type:'text/plain',sha256:'a',filename:'BAJA'}},
])('does not opt out for unrelated text or media: %j',async(content)=>{
  await handleInboundMessage('line-4',{...base,...content} as WebhookMessage,[],'test')
  expect(m.record).not.toHaveBeenCalled()
  expect(m.confirm).not.toHaveBeenCalled()
})
it('propagates consent storage failures so the webhook can retry without sending',async()=>{
  m.record.mockRejectedValue(Error('database unavailable'))
  await expect(handleInboundMessage('line-4',{...base,type:'text',text:{body:'BAJA'}},[],'test')).rejects.toThrow('database unavailable')
  expect(m.automation).not.toHaveBeenCalled()
  expect(m.confirm).not.toHaveBeenCalled()
})
it('accepts Evolution button IDs and titles but excludes media captions',()=>{
  expect(evolutionOptOutCandidates({buttonsResponseMessage:{selectedButtonId:'BAJA',selectedDisplayText:'Salir'}})).toEqual(['BAJA','Salir'])
  expect(evolutionOptOutCandidates({templateButtonReplyMessage:{selectedId:'stop',selectedDisplayText:'BAJA'}})).toEqual(['stop','BAJA'])
  expect(evolutionOptOutCandidates({imageMessage:{caption:'BAJA'}})).toEqual([])
})
