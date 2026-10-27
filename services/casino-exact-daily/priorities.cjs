'use strict';
const ENDPOINT='https://whatsapp-panel-production-f768.up.railway.app/api/contacts/recompute-priorities';
function checkedResult(body){
 if(!body||!['processed','eligible','skipped','durationMs'].every(k=>Number.isFinite(body[k])&&body[k]>=0))throw Error('PRIORITIES_INVALID_RESPONSE');
 if(body.rankingStatus!=='updated')throw Error('PRIORITIES_RANKING_UNAVAILABLE');
 return {processed:body.processed,eligible:body.eligible,skipped:body.skipped,durationMs:body.durationMs,rankingStatus:body.rankingStatus};
}
async function persistedResult(db,before,{sleep,now,pollTimeoutMs}){
 const deadline=now()+pollTimeoutMs;
 while(now()<deadline){
  const {rows}=await db.query(`SELECT j.is_running,j.last_complete_run_id,j.last_result,
    (r.started_at >= $1::timestamptz AND r.status='success') AS recent_complete
    FROM system_jobs j LEFT JOIN recompute_runs r ON r.run_id=j.last_complete_run_id
    WHERE j.job_name='prioritization_recompute'`,[before.checked_at]);
  const row=rows[0];
  if(!row)throw Error('PRIORITIES_JOB_MISSING');
  if(!row.is_running){
   if(row.recent_complete&&row.last_complete_run_id!==before.last_complete_run_id)return checkedResult(row.last_result);
   throw Error('PRIORITIES_COMPLETION_UNVERIFIED');
  }
  await sleep(15000);
 }
 throw Error('PRIORITIES_COMPLETION_TIMEOUT');
}
async function recomputePriorities({apply,failedAgents,env=process.env,fetchImpl=fetch,db,
 sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,pollTimeoutMs=25*60000}){
 if(!apply||failedAgents)return {skipped:true,reason:!apply?'preview':'incomplete_sync'};
 if(!env.CRON_SECRET)throw Error('PRIORITIES_AUTH_MISSING');
 const before=db?(await db.query("SELECT clock_timestamp() AS checked_at,is_running,last_complete_run_id FROM system_jobs WHERE job_name='prioritization_recompute'")).rows[0]:null;
 if(db&&!before)throw Error('PRIORITIES_JOB_MISSING');
 if(before?.is_running)return {skipped:true,reason:'already_running'};
 let response;
 try{response=await fetchImpl(ENDPOINT,{method:'POST',headers:{'x-cron-secret':env.CRON_SECRET},redirect:'error',signal:AbortSignal.timeout(5*60000)});}catch{
  if(before)return persistedResult(db,before,{sleep,now,pollTimeoutMs});
  throw Error('PRIORITIES_REQUEST_FAILED');
 }
 if(response.status===409)return {skipped:true,reason:'already_running'};
 if(!response.ok){
  if(before&&[502,503,504].includes(response.status))return persistedResult(db,before,{sleep,now,pollTimeoutMs});
  throw Error('PRIORITIES_HTTP_'+response.status);
 }
 const body=await response.json().catch(()=>null);
 return checkedResult(body);
}
module.exports={recomputePriorities};
