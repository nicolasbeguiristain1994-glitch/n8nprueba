import {expect,it,vi} from 'vitest'
vi.mock('@/lib/campaign-risk',()=>({CampaignRiskError:class extends Error{}}))
import {assertBroadcastPlanSend,isBroadcastPlanOpen,BroadcastPlanSendError} from '@/lib/broadcast-plan-guard'
const plan={startsAt:'2026-11-04T12:00:00Z',endsAt:'2026-11-04T23:00:00Z',assignments:{'5491100000001':'line-a'}}
it('permits only the exact approved sender/destination inside the Argentina window',()=>{
  const start=Date.parse(plan.startsAt),end=Date.parse(plan.endsAt)
  expect(()=>assertBroadcastPlanSend(plan,'+54 91100000001','line-a',start)).not.toThrow()
  for(const [phone,line,at] of [['5491100000001','line-b',start],['5491100000002','line-a',start],['5491100000001','line-a',start-1],['5491100000001','line-a',end]] as const)
    expect(()=>assertBroadcastPlanSend(plan,phone,line,at)).toThrow(BroadcastPlanSendError)
  expect(isBroadcastPlanOpen(plan,NaN)).toBe(false)
})
it('keeps ordinary campaigns compatible and fails closed on malformed planned windows',()=>{
  expect(()=>assertBroadcastPlanSend(null,'anything',null)).not.toThrow()
  expect(isBroadcastPlanOpen({...plan,endsAt:'invalid'})).toBe(false)
})
