'use strict';
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
const {agents,plan,closedDay}=require('./schedule.cjs');
const {createSource}=require('./source.cjs');
const {fetchPartitionedDay}=require('./transport.cjs');
const {normalize}=require('./normalize.cjs');
const {processDay}=require('./ledger.cjs');
const {run:refreshProfiles}=require('./profiles.cjs');
const {SyncRunStore}=require('./monitor.cjs');
const {recomputePriorities}=require('./priorities.cjs');
const {segmentContacts}=require('./segmentation.cjs');
const log=value=>console.log(JSON.stringify({at:new Date().toISOString(),...value}));
function safeCode(e){const code=e.reason||e.code||e.message;return typeof code==='string'&&/^[A-Z0-9_]{1,80}$/.test(code)?code:'DAILY_FAILED';}
async function processAgent(c,store,source,{platform,agent,runId,until,apply,assertActive}){
 const cursor=await store.getCursor(platform,agent),range=plan(cursor,until),payloads=[];
 for(const day of range.days){
  assertActive();const signal=AbortSignal.timeout(120000),fetchedAt=new Date().toISOString();
  const data=await fetchPartitionedDay(source,agent,day,{signal,assertActive(){assertActive();signal.throwIfAborted();}});
  payloads.push({platform,agent,day,dayOpen:false,fetchedAt,partitionVerified:data.partitionVerified,sourceIds:data.sourceIds,...normalize(data.raw,platform,agent,day)});
  await store.heartbeat(runId);
 }
 const results=[];
 for(const payload of payloads){assertActive();results.push(await processDay(c,payload,apply));}
 // Ledger commits can precede this transaction. A crash never advances the
 // cursor past a profile failure: the next attempt replays identical IDs.
 const ids=payloads.flatMap(p=>p.rows.map(r=>r.id_rec));
 let profiles={playersUpdated:0,metrics:{ambiguous:0}};
 if(apply)profiles=await refreshProfiles(c,ids,true,{beforeCommit:async db=>{
  await store.saveCursor(db,platform,agent,{coveredFrom:range.coveredFrom,coveredThrough:range.coveredThrough},runId);
  for(let i=0;i<payloads.length;i++){
   const p=payloads[i],r=results[i];
   await store.recordRange(db,{runId,platform,agente:agent,desde:p.day,hasta:p.day,status:'success',coverage:'complete',cursorMoved:!cursor||p.day>cursor.coveredThrough,fetchStartedAt:p.fetchedAt,txFetched:p.sourceIds.length,txNormalized:p.rows.length,txInserted:r.inserted,txExcluded:p.excludedIds.length+p.unsupportedIds.length});
  }
 }});
 const result={platform,agent,from:range.days[0],through:range.coveredThrough,backlog:range.backlog,days:results.length,fetched:results.reduce((n,r)=>n+r.sourceRows,0),inserted:results.reduce((n,r)=>n+(apply?r.inserted:r.wouldInsert),0),players:profiles.playersUpdated,ambiguous:profiles.metrics.ambiguous,bet30BonusExcluded:payloads.reduce((n,p)=>n+p.unsupportedIds.length,0)};
 log({event:apply?'agent_complete':'agent_preview',...result});return result;
}
async function main(){
 if(process.env.CASINO_EXACT_DAILY_ENABLED!=='1'){log({event:'daily_disabled'});return;}
 // This dedicated worker cannot enable the legacy four-platform HTTP pipeline.
 if(!['true','1'].includes(process.env.CASINO_SYNC_PAUSED))throw Error('LEGACY_PIPELINE_MUST_STAY_PAUSED');
 const url=new URL(process.env.DATABASE_URL);
 if(url.hostname!=='aws-1-us-east-2.pooler.supabase.com'||url.port!=='5432'||url.pathname!=='/postgres')throw Error('DESTINATION_INVALID');
 const mode=process.env.CASINO_EXACT_DAILY_MODE||'apply';if(!['apply','preview'].includes(mode))throw Error('MODE_INVALID');
 const apply=mode==='apply',until=closedDay(),start=Date.now();
 // Hard process deadline bounds fetch, SQL and cleanup even after disconnects.
 const deadline=setTimeout(()=>{log({event:'daily_failed',code:'JOB_DEADLINE'});process.exit(1);},40*60000);deadline.unref();
 const assertActive=()=>{if(Date.now()-start>35*60000)throw Error('JOB_DEADLINE');};
 const c=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:15000,statement_timeout:120000,application_name:'casino-exact-daily-v1'});
 let connectionLost=false;c.on('error',()=>{connectionLost=true;});
 const assertConnection=()=>{assertActive();if(connectionLost)throw Error('DATABASE_DISCONNECTED');};
 await c.connect();let failures=0;
 try{
  const lock=await c.query("SELECT pg_try_advisory_lock(7125,hashtext('casino_sync:daily_worker')) AND pg_try_advisory_lock(7125,hashtext('casino_sync:zeus')) AND pg_try_advisory_lock(7125,hashtext('casino_sync:bet30')) AND pg_try_advisory_lock(hashtext('casino-excel-import')) locked");
  if(!lock.rows[0].locked)throw Error('WRITER_BUSY');
  const types=await c.query("SELECT count(*)::int n FROM pg_attribute WHERE attrelid='casino_players'::regclass AND attname IN('total_cargas','total_retiros') AND format_type(atttypid,atttypmod)='numeric(20,2)'");if(types.rows[0].n!==2)throw Error('DECIMAL_SCHEMA_REQUIRED');
  const runIds=[];
  const store=new SyncRunStore(c,{instanceId:'exact-daily:'+require('node:os').hostname()+':'+process.pid});
  log({event:'daily_started',mode,through:until,agents:12});
  for(const platform of Object.keys(agents)){
   assertConnection();const runId=randomUUID(),counters={agentsTotal:6,agentsOk:0,agentsFailed:0,rangesOk:0,rangesFailed:0,txFetched:0,txInserted:0,playersRecomputed:0};
   // Preview is a monitored run but never claims coverage or mutates the ledger.
   await store.closeInterruptedRuns(platform,runId,45);
   await store.startRun({runId,platform,mode:'auto',triggeredBy:'pipeline',requestedDesde:null,requestedHasta:until,requestedAgents:agents[platform]});
   runIds.push(runId);
   let platformError=null,source;
   try{source=createSource(platform);await source.authenticate();}catch(e){platformError=safeCode(e);}
   for(const agent of agents[platform]){
    try{
     if(platformError)throw Error(platformError);assertConnection();
     const r=await processAgent(c,store,source,{platform,agent,runId,until,apply,assertActive:assertConnection});
     counters.txFetched+=r.fetched;counters.txInserted+=apply?r.inserted:0;counters.playersRecomputed+=r.players;counters.rangesOk+=r.days;
     if(r.backlog)throw Error('BACKLOG_REMAINS');counters.agentsOk++;
    }catch(e){
     const code=safeCode(e);counters.agentsFailed++;counters.rangesFailed++;failures++;
     await store.recordRange(c,{runId,platform,agente:agent,status:'failed',errorCode:code,errorMessage:'El agente no terminó. Su cursor conserva el último tramo confirmado.'});
     log({event:'agent_failed',platform,agent,code});
    }
    await store.heartbeat(runId);
   }
   await store.finishRun(runId,{status:counters.agentsFailed?(counters.agentsOk?'partial':'failed'):'success',counters,errorCode:counters.agentsFailed?'AGENT_FAILURES':null,segmentationStatus:apply&&!counters.agentsFailed?'pending':'not_requested'});
   log({event:'platform_finished',platform,runId,...counters});
  }
  assertConnection();
  try {
   if(apply)for(const runId of runIds)await store.setSegmentationStatus(runId,'running');
   const segmentation=await segmentContacts(c,{apply,failedAgents:failures});
   if(apply)for(const runId of runIds)await store.setSegmentationStatus(runId,failures?'skipped':'success');
   log({event:'segmentation_finished',...segmentation});
  } catch(e) {
   for(const runId of runIds)await store.setSegmentationStatus(runId,'failed').catch(()=>{});
   throw e;
  }
  const priorities=await recomputePriorities({apply,failedAgents:failures});
  log({event:'priorities_finished',...priorities});
  log({event:'daily_finished',mode,failedAgents:failures,through:until});
 }finally{await c.end();clearTimeout(deadline);}
 if(failures)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{log({event:'daily_failed',code:safeCode(e)});process.exitCode=1;});
module.exports={processAgent,safeCode};
