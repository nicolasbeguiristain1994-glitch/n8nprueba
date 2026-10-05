-- Additive profile storage; no contact or historical campaign is removed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS segmentation_profile jsonb;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS segment_is_manual boolean NOT NULL DEFAULT false;
ALTER TABLE public.contact_lists ADD COLUMN IF NOT EXISTS is_dynamic boolean NOT NULL DEFAULT false;
ALTER TABLE public.contact_lists ADD COLUMN IF NOT EXISTS refreshed_at timestamptz;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS audience_snapshot_at timestamptz;
CREATE TABLE IF NOT EXISTS public.campaign_audience_members (
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  PRIMARY KEY(campaign_id,contact_id)
);
ALTER TABLE public.campaign_audience_members ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS campaign_audience_members_contact ON public.campaign_audience_members(contact_id);

-- These settings now describe pesos per active month, matching Contactos.
UPDATE public.segmentation_tiers SET deposit_threshold_min=v.amount,updated_at=NOW()
FROM (VALUES ('bajo',0),('medio',100000),('vip',500000),('vip_medio',1000000),
  ('vip_alto',1500000),('super_vip',3200000)) v(tier,amount)
WHERE segmentation_tiers.tier=v.tier AND workspace_id='default'
  AND deposit_threshold_min IS DISTINCT FROM v.amount;
COMMENT ON COLUMN public.segmentation_tiers.deposit_threshold_min IS 'Pesos por mes con depósitos reales; umbral compartido por Contactos y Dashboard.';

CREATE OR REPLACE FUNCTION public.validate_monthly_tiers() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('monthly-tier-settings'));
  IF EXISTS (SELECT 1 FROM (
    SELECT deposit_threshold_min,lag(deposit_threshold_min) OVER (ORDER BY array_position(ARRAY['bajo','medio','vip','vip_medio','vip_alto','super_vip'],tier)) previous
    FROM public.segmentation_tiers WHERE workspace_id='default'
  ) t WHERE previous>=deposit_threshold_min) OR EXISTS (
    SELECT 1 FROM public.segmentation_tiers WHERE workspace_id='default' AND tier='bajo' AND deposit_threshold_min<>0
  ) THEN RAISE EXCEPTION 'Los umbrales deben aumentar desde Bajo (0) hasta Super VIP' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS monthly_tiers_order ON public.segmentation_tiers;
CREATE TRIGGER monthly_tiers_order AFTER UPDATE OF deposit_threshold_min ON public.segmentation_tiers
  FOR EACH STATEMENT EXECUTE FUNCTION public.validate_monthly_tiers();

CREATE OR REPLACE FUNCTION public.casino_monthly_value_tier(amount numeric)
RETURNS text LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
  SELECT tier FROM public.segmentation_tiers WHERE workspace_id='default'
    AND amount IS NOT NULL AND deposit_threshold_min<=amount
    ORDER BY deposit_threshold_min DESC,tier LIMIT 1
$$;
CREATE OR REPLACE FUNCTION public.casino_deposit_activity(first_day date,last_day date,n integer,today date)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=public,pg_catalog AS $$
  SELECT CASE WHEN last_day IS NULL OR last_day>today THEN NULL
    WHEN today-last_day>180 THEN 'perdido' WHEN today-last_day>60 THEN 'inactivo'
    WHEN today-last_day>30 THEN 'en_riesgo'
    WHEN first_day IS NULL OR first_day>last_day THEN NULL
    WHEN today-first_day<=30 THEN 'nuevo'
    WHEN n::numeric/GREATEST((today-first_day)::numeric/7,1)>=3 THEN 'frecuente'
    WHEN n::numeric/GREATEST((today-first_day)::numeric/7,1)>=1 THEN 'regular'
    ELSE 'ocasional' END
$$;
CREATE OR REPLACE FUNCTION public.casino_contact_tenure(first_day date,today date)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=public,pg_catalog AS $$
  SELECT CASE WHEN first_day IS NULL OR first_day>today THEN NULL
    WHEN today-first_day<30 THEN 'nuevo' WHEN today-first_day<90 THEN 'reciente'
    WHEN today-first_day<150 THEN 'establecido' WHEN today-first_day<270 THEN 'veterano' ELSE 'leal' END
$$;

-- Same original amounts, bonus exclusion and Argentina dates as the dashboard.
CREATE OR REPLACE VIEW public.casino_cash_movements WITH (security_invoker=true) AS
SELECT t.id,t.platform,lower(t.username) username_lower,t.agente,
  COALESCE((t.fecha_hora_utc AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,t.fecha) fecha,
  CASE WHEN t.tipo='carga' AND t.platform IN ('zeus','bet30') AND lower(trim(t.raw_detalles))='bono'
    THEN 'bono' ELSE t.tipo END tipo,
  COALESCE(s.monto,t.monto) monto
FROM public.casino_transactions t LEFT JOIN public.casino_financial_source_records s
 ON s.transaction_id=t.id AND s.platform=t.platform AND s.kind='importe_original';

CREATE OR REPLACE VIEW public.casino_dashboard_players WITH (security_invoker=true) AS
SELECT platform,username_lower,agente,first_deposit_agent,total_cargas,total_retiros,
  cant_cargas,cant_retiros,fecha_primera,fecha_ultima,
  public.casino_monthly_value_tier(total_cargas/greatest(meses_activos,1)) AS seg_monto,
  public.casino_deposit_activity(fecha_primera,fecha_ultima,cant_cargas,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date) AS seg_actividad
FROM public.casino_dashboard_account_totals WHERE movimientos>0;
-- Server-side custom authentication owns these objects. Supabase client roles
-- cannot read the campaign audience or financial data through newly added APIs.
REVOKE ALL ON public.campaign_audience_members,public.casino_cash_movements FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON public.campaign_audience_members,public.casino_cash_movements FROM %I',r);
    END IF;
  END LOOP;
END $$;
COMMIT;
