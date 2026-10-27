const {test}=require('node:test');const assert=require('node:assert/strict');
const {recomputePriorities}=require('../priorities.cjs');
test('preview and incomplete sync never request recompute',async()=>{
 const fetchImpl=()=>{throw Error('unexpected fetch')};
 assert.equal((await recomputePriorities({apply:false,failedAgents:0,fetchImpl})).reason,'preview');
 assert.equal((await recomputePriorities({apply:true,failedAgents:1,fetchImpl})).reason,'incomplete_sync');
});
test('authenticated internal call returns only safe numeric counters',async()=>{
 const result=await recomputePriorities({apply:true,failedAgents:0,env:{CRON_SECRET:'test-only'},fetchImpl:async(url,options)=>{
 assert.equal(url,'https://whatsapp-panel-production-f768.up.railway.app/api/contacts/recompute-priorities');
 assert.equal(options.redirect,'error');assert.equal(options.headers['x-cron-secret'],'test-only');
 return {ok:true,status:200,json:async()=>({processed:10,eligible:2,skipped:8,durationMs:123,rankingStatus:'updated',extra:'not propagated'})};
 }});assert.deepEqual(result,{processed:10,eligible:2,skipped:8,durationMs:123,rankingStatus:'updated'});
});
test('auth failures surface and concurrent recompute is not duplicated',async()=>{
 const args={apply:true,failedAgents:0,env:{CRON_SECRET:'test-only'}};
 await assert.rejects(recomputePriorities({...args,fetchImpl:async()=>({ok:false,status:401})}),/PRIORITIES_HTTP_401/);
 assert.equal((await recomputePriorities({...args,fetchImpl:async()=>({ok:false,status:409})})).reason,'already_running');
 await assert.rejects(recomputePriorities({...args,fetchImpl:async()=>({ok:true,status:200,json:async()=>({})})}),/PRIORITIES_INVALID_RESPONSE/);
});

const counters={processed:10,eligible:2,skipped:8,durationMs:100,rankingStatus:'updated'};
function dbSequence(rows){return {query:async()=>({rows:[rows.shift()]})};}
test('ranking unavailable is not a healthy completed sync',async()=>{
 await assert.rejects(recomputePriorities({apply:true,failedAgents:0,env:{CRON_SECRET:'test'},fetchImpl:async()=>({ok:true,status:200,json:async()=>({...counters,rankingStatus:'unavailable'})})}),/PRIORITIES_RANKING_UNAVAILABLE/);
});
test('a gateway timeout waits for a new persisted successful run without sending again',async()=>{
 let calls=0,waits=0;
 const result=await recomputePriorities({apply:true,failedAgents:0,env:{CRON_SECRET:'test'},db:dbSequence([
 {checked_at:'2026-10-27T16:00:00Z',is_running:false,last_complete_run_id:'old'},
 {is_running:true,last_complete_run_id:'old'},
 {is_running:false,last_complete_run_id:'new',recent_complete:true,last_result:counters}
 ]),fetchImpl:async()=>{calls++;return {ok:false,status:502}},sleep:async()=>{waits++;}});
 assert.equal(calls,1);assert.equal(waits,1);assert.deepEqual(result,counters);
});
test('old success and interrupted jobs never become healthy after a transport failure',async()=>{
 for(const last of [{is_running:false,last_complete_run_id:'old',recent_complete:false,last_result:counters},{is_running:false,last_complete_run_id:'new',recent_complete:false}]){
 await assert.rejects(recomputePriorities({apply:true,failedAgents:0,env:{CRON_SECRET:'test'},db:dbSequence([{checked_at:'2026-10-27T16:00:00Z',last_complete_run_id:'old'},last]),fetchImpl:async()=>{throw Error('network')}}),/PRIORITIES_COMPLETION_UNVERIFIED/);
 }
});
test('already running jobs are not started again',async()=>{
 const result=await recomputePriorities({apply:true,failedAgents:0,env:{CRON_SECRET:'test'},db:dbSequence([{is_running:true}]),fetchImpl:async()=>{throw Error('should not call')}});
 assert.equal(result.reason,'already_running');
});
test('waiting is bounded and never treats a long job as success',async()=>{
 let time=0;const db={query:async()=>({rows:[{checked_at:'2026-10-27T16:00:00Z',is_running:time>0}]})};
 await assert.rejects(recomputePriorities({apply:true,failedAgents:0,env:{CRON_SECRET:'test'},db,now:()=>time,pollTimeoutMs:100,sleep:async()=>{time+=101},fetchImpl:async()=>{time=1;return {ok:false,status:504}}}),/PRIORITIES_COMPLETION_TIMEOUT/);
});
