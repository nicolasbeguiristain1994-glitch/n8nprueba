SELECT COALESCE(BOOL_AND(
  i.indisvalid AND i.indisready AND NOT i.indisunique
  AND i.indnkeyatts=3 AND i.indnatts=3 AND am.amname='btree'
  AND i.indrelid='public.casino_transactions'::regclass
  AND pg_get_indexdef(i.indexrelid,1,true)='platform'
  AND pg_get_indexdef(i.indexrelid,2,true)='agente'
  AND regexp_replace(replace(pg_get_indexdef(i.indexrelid,3,true),'::text',''),'[()[:space:]]','','g')=
    'COALESCEfecha_hora_utcATTIMEZONE''America/Argentina/Buenos_Aires''::date,fecha'
  AND i.indoption[0]=0 AND i.indoption[1]=0 AND i.indoption[2]=1
  AND regexp_replace(pg_get_expr(i.indpred,i.indrelid),'[()[:space:]]','','g')='platformISNOTNULL'
),false) AS ok
FROM pg_index i
JOIN pg_class c ON c.oid=i.indexrelid
JOIN pg_am am ON am.oid=c.relam
WHERE i.indexrelid=to_regclass('public.idx_casino_latest_movement');
