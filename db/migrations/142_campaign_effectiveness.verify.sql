SELECT COUNT(*)=2 AND BOOL_AND(COALESCE(
  i.indisvalid AND i.indisready AND NOT i.indisunique AND i.indnkeyatts=3
  AND i.indrelid='public.casino_transactions'::regclass
  AND am.amname='btree'
  AND pg_get_indexdef(i.indexrelid,1,true)='platform'
  AND regexp_replace(replace(pg_get_indexdef(i.indexrelid,2,true),'::text',''),'[()[:space:]]','','g')='lowerusername'
  AND pg_get_indexdef(i.indexrelid,3,true)=e.column_name
  AND regexp_replace(replace(replace(pg_get_expr(i.indpred,i.indrelid),'::text',''),'::numeric',''),'[()[:space:]]','','g')=e.predicate
,false)) AS ok
FROM (VALUES
  ('idx_casino_campaign_deposits_time', 'fecha_hora_utc', 'tipo=''carga''ANDmonto>0ANDfecha_hora_utcISNOTNULL'),
  ('idx_casino_campaign_deposits_date', 'fecha', 'tipo=''carga''ANDmonto>0ANDfecha_hora_utcISNULL')
) e(name, column_name, predicate)
LEFT JOIN pg_index i ON i.indexrelid=to_regclass('public.' || e.name)
LEFT JOIN pg_class c ON c.oid=i.indexrelid
LEFT JOIN pg_am am ON am.oid=c.relam;
