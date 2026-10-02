'use strict';
const ENDPOINT='https://whatsapp-panel-production-f768.up.railway.app/api/contacts/recompute-priorities';
async function recomputePriorities({apply,failedAgents,env=process.env,fetchImpl=fetch}){
 if(!apply||failedAgents)return {skipped:true,reason:!apply?'preview':'incomplete_sync'};
 if(!env.CRON_SECRET)throw Error('PRIORITIES_AUTH_MISSING');
 let response;
 try{response=await fetchImpl(ENDPOINT,{method:'POST',headers:{'x-cron-secret':env.CRON_SECRET},redirect:'error',signal:AbortSignal.timeout(5*60000)});}catch{throw Error('PRIORITIES_REQUEST_FAILED');}
 if(response.status===409)return {skipped:true,reason:'already_running'};
 if(!response.ok)throw Error('PRIORITIES_HTTP_'+response.status);
 const body=await response.json().catch(()=>null);
 if(!body||!['processed','eligible','skipped','durationMs'].every(k=>Number.isFinite(body[k])&&body[k]>=0))throw Error('PRIORITIES_INVALID_RESPONSE');
 return {processed:body.processed,eligible:body.eligible,skipped:body.skipped,durationMs:body.durationMs};
}
module.exports={recomputePriorities};
