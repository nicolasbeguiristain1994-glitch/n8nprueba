// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/segmentation-config-service',()=>({getAllTiers:vi.fn().mockRejectedValue(new Error('defaults'))}))
import { computeScore } from '@/lib/user-prioritization/scoring'
import { checkEligibility } from '@/lib/user-prioritization/prioritization-rules'
import { UserPrioritizationService } from '@/lib/user-prioritization/UserPrioritizationService'
import type { UserPrioritizationRepository } from '@/lib/user-prioritization/UserPrioritizationRepository'
import { isFreshCalculation, relativeRanking } from '@/lib/user-prioritization/priority-details'
const base={status:'active',doNotContact:false,optInMarketing:true,deletedAt:null,lastDepositAt:new Date(),segment:'bajo',totalDepositAmount:150000,daysInactive:14,daysSinceLastMessage:null,ltvTier:'super_vip' as const,ltvScore:60}

describe('commercial level and relative ranking are independent',()=>{
 it('Synthetic low-value contact stays Bajo and is not eligible at 14 days even with a super_vip LTV',()=>{
  expect(checkEligibility(base)).toMatchObject({eligible:false,valueTier:'bajo',skipReasons:['still_active']})
  expect(computeScore(base)).toMatchObject({valueTier:'bajo',valueScore:10,reactivationSegment:null})
 })
 it('a lifetime total cannot turn a monthly Bajo into Super VIP',()=>{
  expect(computeScore({...base,totalDepositAmount:999999999})).toMatchObject({valueTier:'bajo',valueScore:10})
 })
 it('a low relative ranking cannot demote the commercial level or shorten its window',()=>{
  const input={...base,segment:'super_vip',daysInactive:170,ltvTier:'bajo' as const,ltvScore:10}
  expect(checkEligibility(input)).toMatchObject({eligible:true,valueTier:'super_vip'})
  expect(computeScore(input)).toMatchObject({valueTier:'super_vip',valueScore:60})
 })
 it('unknown levels are not silently eligible as Bajo',()=>{
  expect(checkEligibility({...base,segment:null,daysInactive:35})).toMatchObject({eligible:false,skipReasons:['unknown_value_tier']})
 })
 it('flags expired and future rankings, and rejects invalid percentiles',()=>{
  const now=Date.parse('2026-10-14T18:00:00Z')
  expect(isFreshCalculation('2026-10-14T07:00:00Z',now)).toBe(true)
  expect(isFreshCalculation('2026-09-30T23:00:00Z',now)).toBe(false)
  expect(isFreshCalculation('2026-10-15T07:00:00Z',now)).toBe(false)
  expect(relativeRanking({percentile:52.5,net:125000,calculated_at:'2026-10-14T07:00:00Z',agent:'fixture-agent',platform:'zeus'},now)).toMatchObject({status:'fresh',percentile:52.5})
  expect(relativeRanking({percentile:91.25,calculated_at:'2026-09-30T23:00:00Z'},now)).toMatchObject({status:'stale'})
  expect(relativeRanking({percentile:101,calculated_at:'2026-10-14T07:00:00Z'},now)).toBeNull()
 })
})

function fixture(failedRanking=false) {
 const events:string[]=[]
 const contact={...base,contactId:'fixture-low',phoneNumber:'+5491100000000',firstName:'Synthetic low-value contact',lastName:null,totalDeposits:22,lastDepositAmount:3000,lastDepositAt:new Date(Date.now()-14*86400000)}
 const repo={withRecomputeSession:vi.fn(async(work:any)=>work(repo)),acquireRecomputeLock:vi.fn(async()=>true),releaseRecomputeLock:vi.fn(async()=>true),renewRecomputeLock:vi.fn(async()=>true),prepareMetrics:vi.fn(async()=>{events.push('prepare')}),fetchContactMetrics:vi.fn(async()=>[contact]),getLastMessagedDaysMap:vi.fn(async()=>new Map()),upsertScores:vi.fn(async(..._args:any[])=>{events.push('scores')}),insertRecomputeRun:vi.fn(async()=>{})}
 const ranking={recomputeAll:vi.fn(async()=>{events.push('ranking');if(failedRanking)throw new Error('ranking unavailable');return {} as any})}
 return {events,repo,ranking,service:new UserPrioritizationService(repo as unknown as UserPrioritizationRepository,ranking)}
}
describe('daily ranking dependency',()=>{
 it('refreshes LTV before reading metrics and persists the commercial result',async()=>{
  const f=fixture();const result=await f.service.recomputeAll()
  expect(f.events).toEqual(['ranking','prepare','scores'])
  expect(result).toMatchObject({rankingStatus:'updated',processed:1,eligible:0})
  expect(f.repo.upsertScores.mock.calls[0][0]).toEqual([expect.objectContaining({valueTier:'bajo',isEligible:false,priorityScore:0,ltvTier:null,ltvScore:null})])
 })
 it('reports a ranking failure while preserving independent commercial computation',async()=>{
  const f=fixture(true);expect(await f.service.recomputeAll()).toMatchObject({rankingStatus:'unavailable',eligible:0})
  expect(f.events).toEqual(['ranking','prepare','scores'])
 })
})
