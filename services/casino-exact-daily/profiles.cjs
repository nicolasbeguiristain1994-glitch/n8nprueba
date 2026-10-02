'use strict';
const provenance='zeus-bet30-exact-daily-v1';
const taggedPredicate=`t.id_rec=ANY($1::bigint[]) AND t.platform IN('zeus','bet30') AND t.source_id IS NULL AND EXISTS(SELECT 1 FROM casino_transactions i WHERE i.platform=t.platform AND lower(i.username)=lower(t.username) AND i.source_id IS NOT NULL AND i.id_rec IS DISTINCT FROM t.id_rec)`;
const projection=`WITH target AS MATERIALIZED (
 SELECT DISTINCT lower(t.username) uname FROM casino_transactions t WHERE t.id_rec=ANY($1::bigint[]) AND t.platform IN('zeus','bet30') AND t.source_id IS NULL AND lower(t.username)<>lower(t.agente)
), history AS MATERIALIZED (
 SELECT t.*,lower(t.username) uname FROM casino_transactions t JOIN target n ON lower(t.username)=n.uname WHERE t.source_id IS NULL AND lower(t.username)<>lower(t.agente)
), totals AS (
 SELECT uname,count(DISTINCT platform)::int platform_count,min(platform) platform,
 coalesce(sum(monto) FILTER(WHERE tipo='carga'),0) total_cargas,coalesce(sum(monto) FILTER(WHERE tipo='retiro'),0) total_retiros,
 count(*) FILTER(WHERE tipo='carga')::int cant_cargas,count(*) FILTER(WHERE tipo='retiro')::int cant_retiros,
 min(fecha) fecha_primera,max(fecha) fecha_ultima,max(fecha) FILTER(WHERE tipo='carga') last_deposit,
 count(DISTINCT date_trunc('month',fecha)) FILTER(WHERE tipo='carga') months
 FROM history GROUP BY uname
), latest AS (SELECT DISTINCT ON(uname) uname,username,agente FROM history ORDER BY uname,fecha DESC,fecha_hora_utc DESC NULLS LAST,id DESC), eligible AS (
 SELECT a.*,r.username,r.agente FROM totals a JOIN latest r USING(uname) LEFT JOIN casino_players cp ON cp.username_lower=a.uname
 WHERE a.platform_count=1 AND a.platform IN('zeus','bet30') AND (cp.platform IS NULL OR cp.platform=a.platform)
 AND NOT EXISTS(SELECT 1 FROM casino_transactions i WHERE i.platform=a.platform AND lower(i.username)=a.uname AND i.source_id IS NOT NULL)
)`;
async function run(c,ids,apply,{beforeCommit=async()=>{}}={}){
 await c.query((apply?'BEGIN':'BEGIN READ ONLY')+"; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'; SET LOCAL TIME ZONE 'America/Argentina/Buenos_Aires';");
 try{
  if(apply){
   const lock=await c.query("SELECT pg_try_advisory_xact_lock(7125,hashtext('casino_sync:daily_worker')) AND pg_try_advisory_xact_lock(7125,hashtext('casino_sync:zeus')) AND pg_try_advisory_xact_lock(7125,hashtext('casino_sync:bet30')) AND pg_try_advisory_xact_lock(hashtext('casino-excel-import')) locked");
   if(!lock.rows[0].locked)throw Error('WRITER_BUSY');await c.query('LOCK TABLE casino_transactions,casino_players IN SHARE ROW EXCLUSIVE MODE');
   const types=await c.query("SELECT count(*)::int n FROM pg_attribute WHERE attrelid='casino_players'::regclass AND attname IN('total_cargas','total_retiros') AND format_type(atttypid,atttypmod)='numeric(20,2)'");if(types.rows[0].n!==2)throw Error('DECIMAL_SCHEMA_REQUIRED');
  }
  const tagged=(await c.query(`SELECT count(*)::int movements,count(DISTINCT (t.platform,lower(t.username)))::int accounts FROM casino_transactions t WHERE ${taggedPredicate}`,[ids])).rows[0];
  if(apply)await c.query(`UPDATE casino_transactions t SET source_id='api:'||t.platform||':'||t.id_rec::text,source_file=$2 WHERE ${taggedPredicate}`,[ids,provenance]);
  if(apply)await c.query('CREATE TEMP TABLE _zeus_bet30_profile_stage ON COMMIT DROP AS '+projection+' SELECT * FROM eligible',[ids]);
  const metrics=(await c.query(projection+` SELECT (SELECT count(*)::int FROM totals) candidates,(SELECT count(*)::int FROM totals WHERE platform_count>1) ambiguous,(SELECT count(*)::int FROM ${apply?'_zeus_bet30_profile_stage':'eligible'}) eligible`,[ids])).rows[0];
  const stage='WITH eligible AS (SELECT * FROM _zeus_bet30_profile_stage)';
  let updated=0;
  if(apply){
   const result=await c.query(stage+` INSERT INTO casino_players(username,agente,platform,total_cargas,total_retiros,cant_cargas,cant_retiros,fecha_primera,fecha_ultima,seg_monto,seg_actividad,updated_at)
 SELECT username,agente,platform,total_cargas,total_retiros,cant_cargas,cant_retiros,fecha_primera,fecha_ultima,
 CASE WHEN total_cargas/greatest(months,1)>=3200000 THEN 'super_vip' WHEN total_cargas/greatest(months,1)>=1500000 THEN 'vip_alto' WHEN total_cargas/greatest(months,1)>=1000000 THEN 'vip_medio' WHEN total_cargas/greatest(months,1)>=500000 THEN 'vip' WHEN total_cargas/greatest(months,1)>=100000 THEN 'medio' ELSE 'bajo' END,
 CASE WHEN last_deposit IS NULL OR current_date-last_deposit>180 THEN 'perdido' WHEN current_date-last_deposit>60 THEN 'inactivo' WHEN current_date-last_deposit>30 THEN 'en_riesgo' WHEN current_date-fecha_primera<=30 THEN 'nuevo' WHEN cant_cargas/greatest((current_date-fecha_primera)::numeric/7,1)>=3 THEN 'frecuente' WHEN cant_cargas/greatest((current_date-fecha_primera)::numeric/7,1)>=1 THEN 'regular' ELSE 'ocasional' END,now() FROM eligible
 ON CONFLICT(username_lower) DO UPDATE SET agente=excluded.agente,platform=excluded.platform,total_cargas=excluded.total_cargas,total_retiros=excluded.total_retiros,cant_cargas=excluded.cant_cargas,cant_retiros=excluded.cant_retiros,fecha_primera=excluded.fecha_primera,fecha_ultima=excluded.fecha_ultima,seg_monto=excluded.seg_monto,seg_actividad=excluded.seg_actividad,updated_at=excluded.updated_at`);updated=result.rowCount;
   if(updated!==metrics.eligible)throw Error('PLAYER_COUNT_MISMATCH');
   const verification=await c.query(stage+` SELECT count(*)::int differences FROM eligible e JOIN casino_players cp ON cp.username_lower=e.uname WHERE cp.platform IS DISTINCT FROM e.platform OR cp.total_cargas IS DISTINCT FROM e.total_cargas OR cp.total_retiros IS DISTINCT FROM e.total_retiros OR cp.cant_cargas IS DISTINCT FROM e.cant_cargas OR cp.cant_retiros IS DISTINCT FROM e.cant_retiros OR cp.fecha_primera IS DISTINCT FROM e.fecha_primera OR cp.fecha_ultima IS DISTINCT FROM e.fecha_ultima`);if(verification.rows[0].differences)throw Error('PLAYER_VERIFY_FAILED');
  }
  if(apply)await beforeCommit(c);
  await c.query(apply?'COMMIT':'ROLLBACK');return {applied:apply,taggedImportedHistory:tagged,metrics,playersUpdated:updated};
 }catch(e){await c.query('ROLLBACK');throw e}
}
module.exports={run,projection};
