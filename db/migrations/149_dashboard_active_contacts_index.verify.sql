SELECT COALESCE(BOOL_AND(
  i.indisvalid AND i.indisready AND NOT i.indisunique
  AND i.indnkeyatts=1 AND i.indnatts=1 AND am.amname='btree'
  AND i.indrelid='public.contacts'::regclass
  AND pg_get_indexdef(i.indexrelid,1,true)='created_at'
  AND i.indoption[0]=3
  AND regexp_replace(pg_get_expr(i.indpred,i.indrelid),'[()[:space:]]','','g')='deleted_atISNULL'
),false) AS ok
FROM pg_index i
JOIN pg_class c ON c.oid=i.indexrelid
JOIN pg_am am ON am.oid=c.relam
WHERE i.indexrelid=to_regclass('public.idx_contacts_active_created');
