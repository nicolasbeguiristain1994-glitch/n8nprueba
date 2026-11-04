import { describe, expect, it } from 'vitest'
import { buildBroadcastPlan, planLineCapacity, broadcastPlanWindow, broadcastPlanningDays, type PlanningContact, type PlanningLine, type BroadcastPlanOptions } from '@/lib/broadcast-planner'
import { DEFAULT_GLOBAL_RULE } from '@/lib/contact-frequency/rules'
import { INACTIVITY_WINDOWS, RECONTACT_COOLDOWN_DAYS, DEPOSIT_AMOUNT_TIERS } from '@/lib/user-prioritization/config'

const now = new Date('2026-11-03T12:00:00Z') // 09:00 Argentina
const options: BroadcastPlanOptions = {lineIds:['a','b'],messageType:'text',endTime:'20:00',reservePercent:0,maxContacts:5000}
const line = (id:string,extra:Partial<PlanningLine>={}):PlanningLine => ({id,name:id,type:'evolution',status:'active',connected:true,enabled:true,campaignAllowed:true,
  dailyLimit:500,hourlyLimit:100,sentToday:0,sentHour:0,dayResetAt:null,hourResetAt:null,priority:1,committed:0,wabaId:null,
  cloudReady:false,activeHours:null,timezoneOffset:-3,invalidSchedule:false,...extra})
const contact = (n:number,extra:Partial<PlanningContact>={}):PlanningContact => ({id:String(n).padStart(4,'0'),name:`Contacto ${n}`,phone:`54911000${String(n).padStart(4,'0')}`,score:100-n/1000,
  segment:'REACTIVACION_PRIORITARIA',tier:'vip',agent:'royal',status:'active',optedIn:true,doNotContact:false,deleted:false,blacklisted:false,
  lastDepositAt:'2026-09-01T12:00:00Z',computedAt:now.toISOString(),lastSentAt:null,sentToday:0,sentWeek:0,alreadyQueued:false,hasAssignment:false,assignedLineId:null,...extra})
const build = (contacts:PlanningContact[],lines=[line('a'),line('b')],overrides:Partial<BroadcastPlanOptions>={}) => buildBroadcastPlan({contacts,lines,options:{...options,...overrides},now,
  computedAt:now.toISOString(),templateWaba:'waba',frequencyRule:DEFAULT_GLOBAL_RULE,
  eligibilityConfig:{inactivityWindows:INACTIVITY_WINDOWS,recontactCooldownDays:RECONTACT_COOLDOWN_DAYS,depositAmountTiers:DEPOSIT_AMOUNT_TIERS}})

describe('daily broadcast planning',()=>{
  it('allocates unequal capacity proportionally and keeps priority order',()=>{
    const result=build(Array.from({length:500},(_,i)=>contact(i)),[line('a',{dailyLimit:400}),line('b',{dailyLimit:100})])
    expect(result.lines.map(l=>l.selected)).toEqual([400,100])
    expect(result.selected).toBe(500)
    expect(result.contacts[0].id).toBe('0000')
  })
  it('keeps habitual senders, even when unavailable, full or deleted',()=>{
    const result=build([contact(1,{hasAssignment:true,assignedLineId:'a'}),contact(2,{hasAssignment:true,assignedLineId:'a'}),contact(3,{hasAssignment:true,assignedLineId:null}),contact(4,{hasAssignment:true,assignedLineId:'hidden'})],
      [line('a',{dailyLimit:1}),line('b')])
    expect(result.selected).toBe(1)
    expect(result.contacts.map(c=>c.reason)).toEqual([null,'assigned_line_full','assigned_line_unavailable','assigned_line_unavailable'])
  })
  it('does not give the only habitual slot to a new phone when another line has room',()=>{
    const result=build([contact(1),contact(2,{hasAssignment:true,assignedLineId:'a'})],[line('a',{dailyLimit:1}),line('b',{dailyLimit:1})])
    expect(result.contacts.map(c=>c.lineId)).toEqual(['b','a'])
  })
  it('subtracts consumed messages, pending messages and attention reserve',()=>{
    const result=build([contact(1)],[line('a',{sentToday:200,committed:100})],{reservePercent:10})
    expect(result.lines[0].capacity).toBe(150)
    expect(result.lines[0].reserve).toBe(50)
  })
  it('uses expired counters without resetting or mutating them',()=>{
    const a=line('a',{sentToday:500,sentHour:100,dayResetAt:'2026-11-03T10:00:00Z',hourResetAt:'2026-11-03T11:00:00Z'})
    expect(build([contact(1)],[a]).lines[0].capacity).toBe(500)
    expect(a.sentToday).toBe(500)
  })
  it('limits estimates by remaining hours and respects a full current hour',()=>{
    const a=line('a',{hourlyLimit:50,sentHour:50,hourResetAt:'2026-11-03T13:00:00Z'})
    expect(planLineCapacity(a,{...options,endTime:'11:00'},now,null).capacity).toBe(50)
    expect(planLineCapacity(a,{...options,endTime:'09:30'},now,null).capacity).toBe(0)
  })
  it('respects active hours and a closing time which already passed',()=>{
    expect(build([], [line('a',{activeHours:[10,11],hourlyLimit:50})]).lines[0].capacity).toBe(50)
    expect(build([], [line('a')],{endTime:'08:30'}).lines[0].capacity).toBe(0)
    expect(broadcastPlanWindow(new Date('2026-11-04T01:00:00Z'),{endTime:'23:00'}).endsAt.toISOString()).toBe('2026-11-04T02:00:00.000Z')
  })
  it('supports overnight schedules in line local time',()=>{
    const result=planLineCapacity(line('a',{activeHours:[19,3],hourlyLimit:50}),{...options,endTime:'23:00'},new Date('2026-11-04T00:00:00Z'),null)
    expect(result.capacity).toBe(100)
  })
  it('enforces provider, WABA and cloud readiness',()=>{
    const lines=[line('a'),line('b',{type:'cloud',wabaId:'other',cloudReady:true}),line('c',{type:'cloud',wabaId:'waba',cloudReady:true}),line('d',{type:'cloud',wabaId:'waba'})]
    const result=build([contact(1)],lines,{messageType:'template',lineIds:['a','b','c','d']})
    expect(result.contacts[0].lineId).toBe('c')
    expect(result.lines.filter(l=>l.capacity>0).map(l=>l.id)).toEqual(['c'])
  })
  it('rechecks consent, recent activity, lifecycle, pending campaigns and phone duplicates',()=>{
    const result=build([contact(1,{optedIn:false}),contact(2,{blacklisted:true}),contact(3,{lastDepositAt:'2026-11-03T13:00:00Z'}),contact(4,{status:'inactive'}),contact(5,{alreadyQueued:true}),contact(6),contact(7,{phone:contact(6).phone}),contact(8,{phone:''})])
    expect(result.contacts.map(c=>c.reason)).toEqual(['excluded','excluded','activity_changed','inactive_status','already_queued',null,'duplicate','invalid_phone'])
    expect(result.total).toBe(result.selected+result.pending+result.excluded)
  })
  it('applies both tier cooldowns and dispatch frequency rules',()=>{
    const result=build([contact(1,{lastSentAt:'2026-11-02T12:00:00Z'}),contact(2,{sentWeek:2}),contact(3)])
    expect(result.contacts.map(c=>c.reason)).toEqual(['no_longer_eligible','frequency',null])
  })
  it('caps selection by descending score, independently of input order',()=>{
    const result=build([contact(9),contact(2),contact(1)],undefined,{maxContacts:1})
    expect(result.contacts.filter(c=>!c.reason).map(c=>c.id)).toEqual(['0001'])
    expect(result.reasons).toContainEqual(expect.objectContaining({code:'selection_limit',count:2}))
  })
  it('caps capacity by the remaining recommendation and deducts commitments once',()=>{
    const result=build([], [line('a',{recommendedRemaining:25,committed:5})],{reservePercent:10})
    expect(result.lines[0].capacity).toBe(20)
    expect(result.lines[0].reserve).toBe(50)
    expect(build([], [line('a',{recommendedRemaining:0,volumeBlocked:true,recommendation:'Revisar calidad'})]).lines[0]).toMatchObject({capacity:0,reason:'Revisar calidad'})
  })
  it('preserves the current Priorities order when scores tie',()=>{
    const result=build([contact(9,{score:100}),contact(1,{score:100})],undefined,{maxContacts:1})
    expect(result.contacts[0]).toMatchObject({id:'0009',reason:null})
  })

  it('resolves dates in Argentina across midnight, month and year boundaries',()=>{
    expect(broadcastPlanningDays(new Date('2027-01-01T01:00:00Z')).map(d=>d.date)).toEqual(['2026-12-31','2027-01-01','2027-01-02'])
    expect(broadcastPlanningDays(new Date('2027-01-01T03:00:00Z'))[0].date).toBe('2027-01-01')
    expect(broadcastPlanningDays(new Date('2028-02-28T12:00:00Z')).map(d=>d.date)).toEqual(['2028-02-28','2028-02-29','2028-03-01'])
    const result=build([],undefined,{planDate:'2026-11-05',startTime:'10:00',endTime:'12:00'})
    expect(result).toMatchObject({planDate:'2026-11-05',startsAt:'2026-11-05T13:00:00.000Z',endsAt:'2026-11-05T15:00:00.000Z'})
    expect(result.lines[0].capacity).toBe(200)
  })
  it('uses renewed quotas and the current daily recommendation for future plans, without mutation',()=>{
    const a=line('a',{sentToday:500,sentHour:100,dayResetAt:'2026-11-04T03:00:00Z',hourResetAt:'2026-11-03T13:00:00Z',recommendedRemaining:0,recommendedDaily:25,committed:5})
    expect(build([], [a]).lines[0].capacity).toBe(0)
    const tomorrow=build([], [a],{planDate:'2026-11-04'})
    expect(tomorrow.lines[0]).toMatchObject({used:0,recommendedRemaining:25,capacity:20})
    expect(tomorrow.warnings.some(w=>w.includes('Proyección'))).toBe(true)
    expect(a.sentToday).toBe(500)
    expect(build([], [{...a,volumeBlocked:true,recommendation:'Revisar calidad'}],{planDate:'2026-11-04'}).lines[0].capacity).toBe(0)
  })
  it('counts only the time after a known renewal within the future window',()=>{
    const a=line('a',{sentToday:500,dayResetAt:'2026-11-04T15:00:00Z',hourlyLimit:50})
    expect(build([], [a],{planDate:'2026-11-04',startTime:'09:00',endTime:'13:00'}).lines[0].capacity).toBe(50)
    expect(build([], [{...a,dayResetAt:null}],{planDate:'2026-11-04'}).lines[0].capacity).toBe(0)
    expect(build([], [a],{planDate:'2026-11-04',endTime:'11:00'}).lines[0].capacity).toBe(0)
  })
  it('projects contact cooldown at the chosen start and rechecks the inactivity window',()=>{
    const c=contact(1,{lastSentAt:'2026-10-30T12:00:00Z'})
    expect(build([c]).selected).toBe(0)
    expect(build([c],undefined,{planDate:'2026-11-04'}).selected).toBe(1)
    const endingWindow=contact(2,{lastDepositAt:new Date(now.getTime()-150*86_400_000).toISOString()})
    expect(build([endingWindow]).selected).toBe(1)
    expect(build([endingWindow],undefined,{planDate:'2026-11-05'}).selected).toBe(0)
  })
  it('excludes Cloud credentials that expire before the chosen future closing time',()=>{
    const a=line('a',{type:'cloud',wabaId:'waba',cloudReady:true,tokenExpiresAt:'2026-11-04T15:00:00Z'})
    expect(build([], [a],{messageType:'template'}).lines[0].capacity).toBeGreaterThan(0)
    expect(build([], [a],{messageType:'template',planDate:'2026-11-04'}).lines[0]).toMatchObject({capacity:0,reason:'Las credenciales Cloud vencen antes del cierre elegido'})
  })

})
