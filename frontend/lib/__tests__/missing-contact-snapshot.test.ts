// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MissingContactSnapshotStore, filterMissingContactSnapshot, missingContactCutoff } from '../missing-contact-snapshot'
import type { MissingContact } from '../missing-contact-types'
const row=(username:string,agent='royal',movement:string|null='2026-10-01',first:string|null=null):MissingContact=>({username,agent,source_agent:agent,platform:'zeus',last_movement:movement,first_seen_at:first})
const filters={agent:'',platform:'',months:6,includeNew:true,q:'',page:1}
let store:MissingContactSnapshotStore
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));store=new MissingContactSnapshotStore()})
afterEach(()=>{store.reset();vi.useRealTimers()})
it('warms before traffic and deduplicates concurrent readers, refreshes and timers',async()=>{
 let resolve!:(rows:MissingContact[])=>void
 const load=vi.fn(()=>new Promise<MissingContact[]>(r=>{resolve=r}))
 const startup=store.start(load),one=store.read(load),two=store.read(load)
 await Promise.resolve();expect(load).toHaveBeenCalledOnce()
 resolve([row('active')]);await startup;expect((await one).users).toEqual((await two).users)
 await store.read(load);await store.start(load);expect(load).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(1)
})
it('returns immediately during a background refresh without a stampede',async()=>{
 await store.refresh(async()=>[row('old')]);vi.setSystemTime(new Date('2026-10-08T12:01:01Z'))
 let resolve!:(rows:MissingContact[])=>void
 const load=vi.fn(()=>new Promise<MissingContact[]>(r=>{resolve=r}))
 expect((await store.read(load)).users[0].username).toBe('old');await store.read(load);expect(load).toHaveBeenCalledOnce()
 resolve([row('new')]);await store.refresh(load);expect((await store.read(load)).users[0].username).toBe('new')
})
it('cannot resurrect imported accounts from a query started before their commit',async()=>{
 await store.refresh(async()=>[row('imported'),row('pending')])
 let resolve!:(rows:MissingContact[])=>void
 const load=()=>new Promise<MissingContact[]>(r=>{resolve=r}),refresh=store.refresh(load);await Promise.resolve()
 store.remove([row('imported')]);expect((await store.read(load)).users.map(r=>r.username)).toEqual(['pending'])
 resolve([row('imported'),row('pending')]);await refresh
 expect((await store.read(load)).users.map(r=>r.username)).toEqual(['pending'])
 await store.refresh(async()=>[row('imported'),row('pending')]);expect((await store.read(load)).users).toHaveLength(2)
})
it('does not silently serve indefinitely stale data when refresh fails',async()=>{
 await store.refresh(async()=>[row('active')]);vi.setSystemTime(new Date('2026-10-08T12:05:01Z'))
 await expect(store.read(async()=>{throw Error('unavailable')})).rejects.toThrow('unavailable')
 expect((await store.read(async()=>[row('recovered')])).users[0].username).toBe('recovered')
})
it('matches PostgreSQL calendar month boundaries and the Argentina day',()=>{
 expect(missingContactCutoff(1,new Date('2024-03-31T12:00:00Z')).day).toBe('2024-02-29')
 expect(missingContactCutoff(1,new Date('2025-03-31T12:00:00Z')).day).toBe('2025-02-28')
 expect(missingContactCutoff(6,new Date('2026-10-09T01:30:00Z')).day).toBe('2026-04-08')
})
it('filters exact dates and new users, current scope, search, pages and complete exports',()=>{
 const snapshot={updatedAt:Date.now(),users:[row('active'),row('other','bigwin'),row('boundary','royal','2026-04-08'),row('outside','royal','2026-04-07'),row('new','royal',null,'2026-10-08T10:00:00Z')]}
 expect(filterMissingContactSnapshot(snapshot,['royal'],filters).users.map(r=>r.username)).toEqual(['active','boundary','new'])
 expect(filterMissingContactSnapshot(snapshot,['royal'],{...filters,includeNew:false}).total).toBe(2)
 expect(filterMissingContactSnapshot(snapshot,[],filters).total).toBe(0)
 expect(filterMissingContactSnapshot(snapshot,['royal'],{...filters,agent:'bigwin'}).total).toBe(0)
 expect(filterMissingContactSnapshot(snapshot,['royal'],{...filters,q:'ACT'}).users.map(r=>r.username)).toEqual(['active'])
 expect(filterMissingContactSnapshot(snapshot,['royal'],{...filters,months:0}).total).toBe(4)
 const many={updatedAt:Date.now(),users:Array.from({length:120},(_,i)=>row(String(i)))}
 const second=filterMissingContactSnapshot(many,['royal'],{...filters,page:2})
 expect(second.total).toBe(120);expect(second.users).toHaveLength(50);expect(second.users[0].username).toBe('50')
 expect(filterMissingContactSnapshot(many,['royal'],filters,true).users).toHaveLength(120)
 expect(filterMissingContactSnapshot(many,['royal'],{...filters,page:4}).users).toEqual([])
})

it('treats an old movement on a newly detected account as outside the selected period',()=>{
 const snapshot={updatedAt:Date.now(),users:[row('old-new','royal','2025-01-01','2026-10-08T12:00:00Z'),row('new-without-movements','royal',null,'2026-10-08T10:00:00Z')]}
 const result=filterMissingContactSnapshot(snapshot,['royal'],filters)
 expect(result.users.map(r=>r.username)).toEqual(['old-new','new-without-movements'])
 expect(result.users.every(r=>r.last_movement===null)).toBe(true)
 expect(filterMissingContactSnapshot(snapshot,['royal'],{...filters,includeNew:false}).total).toBe(0)
})
