SELECT
  (SELECT relrowsecurity FROM pg_class WHERE oid='public.campaign_audience_members'::regclass)
  AND (SELECT 'security_invoker=true'=ANY(reloptions) FROM pg_class WHERE oid='public.casino_cash_movements'::regclass)
  AND (SELECT 'security_invoker=true'=ANY(reloptions) FROM pg_class WHERE oid='public.casino_dashboard_players'::regclass)
  AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contacts' AND column_name='segmentation_profile' AND data_type='jsonb')
  AND public.casino_deposit_activity(NULL,NULL,0,CURRENT_DATE) IS NULL
  AND public.casino_deposit_activity(CURRENT_DATE-100,CURRENT_DATE-31,8,CURRENT_DATE)='en_riesgo'
  AND public.casino_monthly_value_tier(NULL) IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon','authenticated') AND
    (has_table_privilege(r.oid,'public.campaign_audience_members','SELECT') OR has_table_privilege(r.oid,'public.casino_cash_movements','SELECT')))
  AS ok;
