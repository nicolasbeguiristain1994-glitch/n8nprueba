vi.mock('@/lib/automation-safety', () => ({ recordHumanAutomationIntervention: vi.fn().mockResolvedValue(undefined) }))
// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ execute: vi.fn(), access: vi.fn(),query:vi.fn(),reserve:vi.fn(),finish:vi.fn() }))
vi.mock('@/lib/db',()=>({query:mocks.query}))
vi.mock('@/lib/line-send-budget',()=>({reserveLineSendBudget:mocks.reserve,finishLineSendBudget:mocks.finish,LineSendBudgetError:class extends Error{code='LINE_SEND_BUDGET_WAIT';retryAt='2030-01-01T00:00:00Z'}}))
vi.mock('@/lib/permissions', () => ({ checkPermissionWithUser: async () => ({ ok: true, user: { user_id: 'operator' } }) }))
vi.mock('@/lib/cloud-api/access', () => ({ cloudNumberAccess: mocks.access }))
vi.mock('@/lib/cloud-api/use-cases/send-message.use-case', () => ({ sendMessageUseCase: { execute: mocks.execute } }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
import { recordHumanAutomationIntervention } from '@/lib/automation-safety'
import { LineSendBudgetError } from '@/lib/line-send-budget'
import { CampaignRiskError } from '@/lib/campaign-risk'
import { POST } from '@/app/api/cloud/messages/route'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.query.mockResolvedValue([{id:'synthetic-line'}]);mocks.reserve.mockResolvedValue({id:'reservation'});mocks.finish.mockResolvedValue(undefined)
  mocks.access.mockResolvedValue(null)
  mocks.execute.mockResolvedValue({ wamid: 'simulated', messageId: 'local-test' })
})
const request = (extra: Record<string, unknown> = {}) => new NextRequest('http://localhost/api/cloud/messages', {
  method: 'POST', body: JSON.stringify({ phoneNumberId: '123456789', to: '+5491100000001', type: 'text', text: { body: 'Prueba local' }, ...extra }),
})

it.each([{ agentCode: 'royal' }, { campaignId: 'another-agent-campaign' }])('rejects caller-supplied consent attribution: %j', async extra => {
  expect((await POST(request(extra))).status).toBe(400)
  expect(mocks.execute).not.toHaveBeenCalled()
})

it('delegates an ordinary message with no caller-selected agent', async () => {
  expect((await POST(request())).status).toBe(200)
  expect(mocks.execute).toHaveBeenCalledWith({ enqueue: false, request: expect.objectContaining({ sentByUserId: 'operator' }) })
  const sent = mocks.execute.mock.calls[0][0].request
  expect(sent).not.toHaveProperty('agentCode')
  expect(sent).not.toHaveProperty('campaignId')
})

it('returns a distinct conflict when the shared sender blocks an unsafe send', async () => {
  mocks.execute.mockRejectedValueOnce(new CampaignRiskError())
  const response = await POST(request())
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'CAMPAIGN_RISK_BLOCKED' })
  expect(mocks.execute).toHaveBeenCalledTimes(1)
})

it('records human intervention before sending and consumes the shared service capacity',async()=>{
 expect((await POST(request())).status).toBe(200)
 expect(recordHumanAutomationIntervention).toHaveBeenCalledWith('+5491100000001',{provider:'cloud',sourceId:'123456789'})
 expect(vi.mocked(recordHumanAutomationIntervention).mock.invocationCallOrder[0]).toBeLessThan(mocks.execute.mock.invocationCallOrder[0])
 expect(mocks.reserve).toHaveBeenCalledWith({lineId:'synthetic-line',purpose:'service',sendKey:expect.stringMatching(/^service:operator:/)})
 expect(mocks.finish).toHaveBeenCalledWith('reservation','consumed')
})
it('does not contact the provider when the shared line capacity is exhausted',async()=>{
 mocks.reserve.mockRejectedValueOnce(new LineSendBudgetError('capacity','2030-01-01T00:00:00Z'))
 expect((await POST(request())).status).toBe(409);expect(mocks.execute).not.toHaveBeenCalled()
})
it('returns capacity after a known pre-provider risk stop, but keeps it after an uncertain send',async()=>{
 mocks.execute.mockRejectedValueOnce(new CampaignRiskError());await POST(request())
 expect(mocks.finish).toHaveBeenLastCalledWith('reservation','no_send')
 mocks.execute.mockRejectedValueOnce(new Error('simulated provider timeout'));await POST(request())
 expect(mocks.finish).toHaveBeenLastCalledWith('reservation','consumed')
})

it('persists only the internally resolved human agent for the next inbound',async()=>{
 vi.mocked(recordHumanAutomationIntervention).mockResolvedValueOnce('royal')
 expect((await POST(request())).status).toBe(200)
 expect(mocks.execute.mock.calls[0][0].request.agentCode).toBe('royal')
})
