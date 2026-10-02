-- Dashboard-only projection of identified transaction history. Financial rows,
-- casino_players, contact matching and marketing segmentation are not rewritten.
-- Bootstrap with refresh_casino_dashboard_accounts(platform, usernames) in bounded
-- batches before deploying the dashboard reader. Statement triggers keep each
-- affected account current in the same transaction as future ledger changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.casino_dashboard_account_totals (
  platform text NOT NULL CHECK (platform IN ('zeus','bet30','ganamos','argenbet')),
  username_lower text NOT NULL,
  agente text,
  first_deposit_agent text,
  total_cargas numeric NOT NULL,
  total_retiros numeric NOT NULL,
  cant_cargas integer NOT NULL,
  cant_retiros integer NOT NULL,
  fecha_primera date,
  fecha_ultima date,
  meses_activos integer NOT NULL,
  movimientos bigint NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (platform, username_lower)
);
ALTER TABLE public.casino_dashboard_account_totals ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.calculate_casino_dashboard_account(p_platform text, p_username text)
RETURNS TABLE (
  platform text, username_lower text, agente text, first_deposit_agent text,
  total_cargas numeric, total_retiros numeric, cant_cargas integer, cant_retiros integer,
  fecha_primera date, fecha_ultima date, meses_activos integer, movimientos bigint
) LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $function$
  WITH cash AS (
    SELECT t.id, lower(trim(t.agente)) AS agente,
      COALESCE((t.fecha_hora_utc AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,t.fecha) AS day,
      t.fecha_hora_utc,
      CASE WHEN t.tipo='carga' AND t.platform IN ('zeus','bet30')
        AND lower(trim(t.raw_detalles))='bono' THEN 'bono' ELSE t.tipo END AS kind,
      COALESCE(s.monto,t.monto) AS amount
    FROM public.casino_transactions t
    LEFT JOIN public.casino_financial_source_records s
      ON s.transaction_id=t.id AND s.platform=t.platform AND s.kind='importe_original'
    WHERE t.platform=p_platform AND lower(t.username)=p_username
  )
  SELECT p_platform,p_username,
    (array_agg(agente ORDER BY day DESC NULLS LAST,fecha_hora_utc DESC NULLS LAST,id DESC))[1],
    (array_agg(agente ORDER BY day ASC NULLS LAST,fecha_hora_utc ASC NULLS LAST,id ASC) FILTER (WHERE kind='carga'))[1],
    COALESCE(sum(amount) FILTER (WHERE kind='carga'),0),
    COALESCE(sum(amount) FILTER (WHERE kind='retiro'),0),
    count(*) FILTER (WHERE kind='carga')::integer,
    count(*) FILTER (WHERE kind='retiro')::integer,
    min(day) FILTER (WHERE kind='carga'),max(day) FILTER (WHERE kind='carga'),
    count(DISTINCT date_trunc('month',day::timestamp)) FILTER (WHERE kind='carga')::integer,
    count(*)
  FROM cash
$function$;

CREATE OR REPLACE FUNCTION public.refresh_casino_dashboard_accounts(p_platform text,p_usernames text[])
RETURNS integer LANGUAGE plpgsql VOLATILE SET search_path = public, pg_catalog AS $function$
DECLARE account text; affected integer := 0;
BEGIN
  IF p_platform IS NULL OR p_platform NOT IN ('zeus','bet30','ganamos','argenbet') THEN RETURN 0; END IF;
  -- One account is the unit of identity and serialization. Lock before the query
  -- so concurrent committed writes are visible to its READ COMMITTED snapshot.
  FOR account IN SELECT DISTINCT lower(u) FROM unnest(p_usernames) u WHERE u IS NOT NULL ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('dashboard-account:' || p_platform || ':' || account,0));
    INSERT INTO public.casino_dashboard_account_totals
      (platform,username_lower,agente,first_deposit_agent,total_cargas,total_retiros,
       cant_cargas,cant_retiros,fecha_primera,fecha_ultima,meses_activos,movimientos,refreshed_at)
    SELECT c.*,clock_timestamp() FROM public.calculate_casino_dashboard_account(p_platform,account) c
    ON CONFLICT (platform,username_lower) DO UPDATE SET
      agente=EXCLUDED.agente,first_deposit_agent=EXCLUDED.first_deposit_agent,
      total_cargas=EXCLUDED.total_cargas,total_retiros=EXCLUDED.total_retiros,
      cant_cargas=EXCLUDED.cant_cargas,cant_retiros=EXCLUDED.cant_retiros,
      fecha_primera=EXCLUDED.fecha_primera,fecha_ultima=EXCLUDED.fecha_ultima,
      meses_activos=EXCLUDED.meses_activos,movimientos=EXCLUDED.movimientos,refreshed_at=EXCLUDED.refreshed_at;
    DELETE FROM public.casino_dashboard_account_totals
      WHERE platform=p_platform AND username_lower=account AND movimientos=0;
    affected := affected + 1;
  END LOOP;
  RETURN affected;
END
$function$;

CREATE OR REPLACE FUNCTION public.refresh_dashboard_from_transactions()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE scope record; affected_sql text;
BEGIN
  IF TG_OP='INSERT' THEN
    affected_sql := 'SELECT platform,lower(username) AS username FROM new_rows';
  ELSIF TG_OP='DELETE' THEN
    affected_sql := 'SELECT platform,lower(username) AS username FROM old_rows';
  ELSE
    -- Ignore provenance-only updates and exact replays. Both sides of a moved
    -- account must be refreshed; never leave a ghost under the old identity.
    affected_sql := 'WITH changed AS (
      SELECT n.platform AS new_platform,n.username AS new_username,o.platform AS old_platform,o.username AS old_username
      FROM new_rows n FULL JOIN old_rows o ON n.id=o.id
      WHERE (n.platform,n.username,n.agente,n.tipo,n.monto,n.fecha,n.fecha_hora_utc,n.raw_detalles)
        IS DISTINCT FROM (o.platform,o.username,o.agente,o.tipo,o.monto,o.fecha,o.fecha_hora_utc,o.raw_detalles)
    ) SELECT new_platform AS platform,lower(new_username) AS username FROM changed
      UNION SELECT old_platform,lower(old_username) FROM changed';
  END IF;
  FOR scope IN EXECUTE 'SELECT platform,array_agg(DISTINCT username ORDER BY username) AS names FROM (' || affected_sql || ') keys
    WHERE platform IN (''zeus'',''bet30'',''ganamos'',''argenbet'') GROUP BY platform ORDER BY platform' LOOP
    PERFORM public.refresh_casino_dashboard_accounts(scope.platform,scope.names);
  END LOOP;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.refresh_dashboard_from_original_amounts()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE scope record; affected_sql text;
BEGIN
  IF TG_OP='INSERT' THEN
    affected_sql := 'SELECT transaction_id FROM new_rows WHERE kind=''importe_original''';
  ELSIF TG_OP='DELETE' THEN
    affected_sql := 'SELECT transaction_id FROM old_rows WHERE kind=''importe_original''';
  ELSE
    affected_sql := 'SELECT transaction_id FROM new_rows WHERE kind=''importe_original''
      UNION SELECT transaction_id FROM old_rows WHERE kind=''importe_original''';
  END IF;
  FOR scope IN EXECUTE 'SELECT t.platform,array_agg(DISTINCT lower(t.username) ORDER BY lower(t.username)) AS names
    FROM public.casino_transactions t JOIN (' || affected_sql || ') changed ON changed.transaction_id=t.id
    WHERE t.platform IN (''zeus'',''bet30'',''ganamos'',''argenbet'') GROUP BY t.platform ORDER BY t.platform' LOOP
    PERFORM public.refresh_casino_dashboard_accounts(scope.platform,scope.names);
  END LOOP;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS dashboard_accounts_insert ON public.casino_transactions;
CREATE TRIGGER dashboard_accounts_insert AFTER INSERT ON public.casino_transactions
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.refresh_dashboard_from_transactions();
DROP TRIGGER IF EXISTS dashboard_accounts_update ON public.casino_transactions;
CREATE TRIGGER dashboard_accounts_update AFTER UPDATE ON public.casino_transactions
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.refresh_dashboard_from_transactions();
DROP TRIGGER IF EXISTS dashboard_accounts_delete ON public.casino_transactions;
CREATE TRIGGER dashboard_accounts_delete AFTER DELETE ON public.casino_transactions
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.refresh_dashboard_from_transactions();
DROP TRIGGER IF EXISTS dashboard_original_insert ON public.casino_financial_source_records;
CREATE TRIGGER dashboard_original_insert AFTER INSERT ON public.casino_financial_source_records
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.refresh_dashboard_from_original_amounts();
DROP TRIGGER IF EXISTS dashboard_original_update ON public.casino_financial_source_records;
CREATE TRIGGER dashboard_original_update AFTER UPDATE ON public.casino_financial_source_records
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.refresh_dashboard_from_original_amounts();
DROP TRIGGER IF EXISTS dashboard_original_delete ON public.casino_financial_source_records;
CREATE TRIGGER dashboard_original_delete AFTER DELETE ON public.casino_financial_source_records
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.refresh_dashboard_from_original_amounts();

-- Only date-dependent classification is evaluated on reads; no ledger rescan.
CREATE OR REPLACE VIEW public.casino_dashboard_players WITH (security_invoker=true) AS
WITH scored AS (
  SELECT *, total_cargas/greatest(meses_activos,1) AS promedio,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS today
  FROM public.casino_dashboard_account_totals
)
SELECT platform,username_lower,agente,first_deposit_agent,total_cargas,total_retiros,
  cant_cargas,cant_retiros,fecha_primera,fecha_ultima,
  CASE WHEN promedio>=3200000 THEN 'super_vip' WHEN promedio>=1500000 THEN 'vip_alto'
    WHEN promedio>=1000000 THEN 'vip_medio' WHEN promedio>=500000 THEN 'vip'
    WHEN promedio>=100000 THEN 'medio' ELSE 'bajo' END AS seg_monto,
  CASE WHEN fecha_ultima IS NULL OR today-fecha_ultima>180 THEN 'perdido'
    WHEN today-fecha_ultima>60 THEN 'inactivo' WHEN today-fecha_ultima>30 THEN 'en_riesgo'
    WHEN today-fecha_primera<=30 THEN 'nuevo'
    WHEN cant_cargas/greatest((today-fecha_primera)::numeric/7,1)>=3 THEN 'frecuente'
    WHEN cant_cargas/greatest((today-fecha_primera)::numeric/7,1)>=1 THEN 'regular'
    ELSE 'ocasional' END AS seg_actividad
FROM scored WHERE movimientos>0;
COMMIT;
