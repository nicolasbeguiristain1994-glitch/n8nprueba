'use strict';
const exact=require('./exact.cjs');
const agents={zeus:['betcoin','bigwin','farabet','ofizeus','royal','imperio'],bet30:['btcuno','btcdos','zeus','zeusroyal','bigwin','imperio']};
const fail=code=>{throw Object.assign(new Error(code),{code})};
const {validDay,closedDay}=require('./schedule.cjs');
function validate(p){
 if(!p||!agents[p.platform]?.includes(p.agent)||!validDay(p.day)||p.day<'2026-09-22'||p.day>closedDay()||p.dayOpen===true||p.partitionVerified!==true)fail('SCOPE_INVALID');
 const ids=new Set(),expected=new Set(p.sourceIds);
 if(expected.size!==p.sourceIds.length)fail('SOURCE_DUPLICATE');
 for(const row of p.rows){
  exact.sourceId(row.id_rec);exact.exactCents(row.monto,{allowNegative:false});
  if(row.platform!==p.platform||row.agente!==p.agent||row.fecha!==p.day||exact.timestamp(row.fecha_hora_utc).day!==p.day||!['carga','retiro'].includes(row.tipo)||typeof row.username!=='string'||!row.username.trim()||row.username!==row.username.trim()||row.username.length>100||row.username.toLowerCase()===p.agent.toLowerCase()||typeof row.raw_detalles!=='string'||Object.hasOwn(row,'source_id'))fail('ROW_INVALID');
  if(ids.has(row.id_rec)||!expected.has(row.id_rec))fail('ROW_ID_INVALID');ids.add(row.id_rec);
 }
 for(const id of [...p.excludedIds,...p.unsupportedIds]){exact.sourceId(id);if(ids.has(id)||!expected.has(id))fail('EXCLUSION_INVALID');ids.add(id)}
 if(ids.size!==expected.size)fail('SOURCE_UNACCOUNTED');
 return p;
}
const columns=`id_rec::text,platform,source_id,source_file,agente,username,tipo,monto::text,fecha::text,to_char(fecha_hora_utc AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS fecha_hora_utc,raw_detalles`;
async function identities(c,p,lock=false){
 // Explicit NULL/non-NULL branches allow both partial identity indexes.
 const rows=[];
 for(const predicate of ['platform IS NULL','platform IS NOT NULL'])rows.push(...(await c.query(`SELECT ${columns} FROM public.casino_transactions WHERE id_rec=ANY($1::bigint[]) AND ${predicate} ${lock?'FOR UPDATE':''}`,[p.sourceIds])).rows);
 return rows;
}
function compare(p,stored,requireAll=false){
 const incoming=new Map(p.rows.map(r=>[r.id_rec,r])),seen=new Set();
 for(const row of stored){
  if(seen.has(row.id_rec))fail('DATABASE_ID_AMBIGUOUS');seen.add(row.id_rec);
  const r=incoming.get(row.id_rec);if(!r)fail('EXCLUDED_ID_ALREADY_EXISTS');
  const owned=row.source_id==='api:'+p.platform+':'+row.id_rec&&['zeus-bet30-api-20260923','zeus-bet30-exact-daily-v1'].includes(row.source_file);
  exact.assertExactReplay(owned?{...row,source_id:null}:row,r,p.platform);
  if(row.username!==r.username||row.raw_detalles!==r.raw_detalles)fail('REPLAY_FIELDS_DIFFER');
 }
 if(requireAll&&p.rows.some(r=>!seen.has(r.id_rec)))fail('PERSISTENCE_INCOMPLETE');
 return p.rows.filter(r=>!seen.has(r.id_rec));
}
async function processDay(c,p,apply=false){
 validate(p);await c.query((apply?'BEGIN':'BEGIN READ ONLY')+"; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';");
 try{
  if(apply){
   const r=await c.query(`SELECT pg_try_advisory_xact_lock(7125,hashtext('casino_sync:daily_worker')) AND pg_try_advisory_xact_lock(7125,hashtext($1)) AND pg_try_advisory_xact_lock(hashtext('casino-excel-import')) AS locked`,['casino_sync:'+p.platform]);
   if(!r.rows[0].locked)fail('WRITER_BUSY');
   await c.query('LOCK TABLE public.casino_transactions IN SHARE ROW EXCLUSIVE MODE');
  }
  const legacy=await c.query('SELECT EXISTS(SELECT 1 FROM public.casino_transactions WHERE platform IS NULL AND fecha=$1 AND lower(btrim(agente))=lower($2)) AS conflict',[p.day,p.agent]);
  if(legacy.rows[0].conflict)fail('LEGACY_RANGE_UNCLASSIFIED');
  const missing=compare(p,await identities(c,p,apply));
  if(apply){
   for(let i=0;i<missing.length;i+=1000){
    const batch=missing.slice(i,i+1000),args=batch.flatMap(r=>[r.platform,r.id_rec,r.fecha,r.fecha_hora_utc,r.agente,r.username,r.tipo,r.monto,r.raw_detalles]);
    const values=batch.map((r,j)=>'('+Array.from({length:9},(_,k)=>'$'+(j*9+k+1)).join(',')+',NULL)').join(',');
    const inserted=await c.query(`INSERT INTO public.casino_transactions(platform,id_rec,fecha,fecha_hora_utc,agente,username,tipo,monto,raw_detalles,source_id) VALUES ${values} RETURNING id_rec::text`,args);
    if(inserted.rowCount!==batch.length)fail('INSERT_COUNT_MISMATCH');
   }
   compare(p,await identities(c,p,true),true);
  }
  await c.query(apply?'COMMIT':'ROLLBACK');
  return {platform:p.platform,agent:p.agent,day:p.day,sourceRows:p.sourceIds.length,financialRows:p.rows.length,existing:p.rows.length-missing.length,[apply?'inserted':'wouldInsert']:missing.length,excluded:p.excludedIds.length,unsupported:p.unsupportedIds.length,dayOpen:p.dayOpen,fetchedAt:p.fetchedAt,cargas:exact.formatCents(p.rows.filter(r=>r.tipo==='carga').reduce((n,r)=>n+exact.exactCents(r.monto),0n)),retiros:exact.formatCents(p.rows.filter(r=>r.tipo==='retiro').reduce((n,r)=>n+exact.exactCents(r.monto),0n))};
 }catch(e){await c.query('ROLLBACK');throw e}
}
module.exports={validate,compare,processDay};
