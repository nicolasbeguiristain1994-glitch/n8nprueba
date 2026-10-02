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
 return {ok:true,status:200,json:async()=>({processed:10,eligible:2,skipped:8,durationMs:123,extra:'not propagated'})};
 }});assert.deepEqual(result,{processed:10,eligible:2,skipped:8,durationMs:123});
});
test('auth failures surface and concurrent recompute is not duplicated',async()=>{
 const args={apply:true,failedAgents:0,env:{CRON_SECRET:'test-only'}};
 await assert.rejects(recomputePriorities({...args,fetchImpl:async()=>({ok:false,status:401})}),/PRIORITIES_HTTP_401/);
 assert.equal((await recomputePriorities({...args,fetchImpl:async()=>({ok:false,status:409})})).reason,'already_running');
 await assert.rejects(recomputePriorities({...args,fetchImpl:async()=>({ok:true,status:200,json:async()=>({})})}),/PRIORITIES_INVALID_RESPONSE/);
});
