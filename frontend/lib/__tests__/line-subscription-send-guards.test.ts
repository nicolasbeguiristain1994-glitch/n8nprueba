// @vitest-environment node
import { beforeEach,afterEach,expect,it,vi } from 'vitest'
const mocks=vi.hoisted(()=>({guard:vi.fn(),providerGuard:vi.fn(),query:vi.fn(),fetch:vi.fn(),optout:vi.fn(),finish:vi.fn()}))
vi.mock('@/lib/line-subscriptions',()=>({SubscriptionConsentError:class extends Error {},assertLineSubscription:mocks.guard,assertProviderSubscription:mocks.providerGuard}))
vi.mock('@/lib/line-send-budget',()=>({finishLineSendBudget:mocks.finish,reserveLineSendBudget:vi.fn(),LineSendBudgetError:class extends Error {},deferCampaignForLineBudget:vi.fn()}))
vi.mock('@/lib/db',()=>({query:mocks.query,withTransaction:vi.fn()}))
vi.mock('@/lib/cloud-api/repositories/compliance.repository',()=>({complianceRepository:{isOptedOut:mocks.optout}}))
import { sendViaCloud,sendViaEvolution,type EligibleLine } from '@/lib/campaign-distributor'
import { SendMessageUseCase } from '@/lib/cloud-api/use-cases/send-message.use-case'
const line={id:'line-1',evolution_instance:'qr-1',evolution_url:'https://example.invalid',phone_number_id:'cloud-1'} as EligibleLine
beforeEach(()=>{vi.resetAllMocks();vi.stubGlobal('fetch',mocks.fetch);vi.stubEnv('EVOLUTION_API_KEY','test');mocks.optout.mockResolvedValue(false);mocks.finish.mockResolvedValue(undefined)})
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()})
it('stops an Evolution campaign before any provider request',async()=>{
  mocks.guard.mockRejectedValue(new Error('BAJA'))
  await expect(sendViaEvolution(line,'5491112345678','Promotion')).rejects.toThrow('BAJA')
  expect(mocks.guard).toHaveBeenCalledWith(line.id,'5491112345678',true)
  expect(mocks.fetch).not.toHaveBeenCalled()
})
it('stops Cloud campaigns before credentials or external requests',async()=>{
  mocks.guard.mockRejectedValue(new Error('No consent'))
  await expect(sendViaCloud(line,'5491112345678',{kind:'text',body:'Promotion',mediaUrl:null})).rejects.toThrow('No consent')
  expect(mocks.fetch).not.toHaveBeenCalled();expect(mocks.query).not.toHaveBeenCalled()
})
it('guards direct and queued templates too',async()=>{
  mocks.providerGuard.mockRejectedValue(new Error('No consent'))
  for(const enqueue of [false,true]) await expect(new SendMessageUseCase().execute({enqueue,request:{phoneNumberId:'cloud-1',to:'+5491112345678',type:'template',template:{name:'offer',language:{code:'es'},components:[]}}})).rejects.toThrow('No consent')
  expect(mocks.providerGuard).toHaveBeenCalledWith('cloud','cloud-1','+5491112345678',true)
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it('refunds a reserved Evolution campaign slot when consent blocks the send',async()=>{
  const {SubscriptionConsentError}=await import('@/lib/line-subscriptions')
  mocks.guard.mockRejectedValueOnce(new SubscriptionConsentError('BAJA'))
  await expect(sendViaEvolution(line,'5491112345678','Promotion',null,undefined,'campaign',{id:'reservation'} as never)).rejects.toThrow('BAJA')
  expect(mocks.fetch).not.toHaveBeenCalled()
  expect(mocks.finish).toHaveBeenCalledWith('reservation','no_send')
})
