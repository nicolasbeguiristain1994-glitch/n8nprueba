-- migrate: transactional
-- Generated with supabase migration new restrict_internal_function_access
-- (20261013200830), numbered here for this repository's ordered catalog.
-- Internal server/trigger functions only. Other products' tables and policies
-- in this shared database are deliberately outside this migration's scope.
DO $migration$
DECLARE
  signature text;
  target regprocedure;
  role_name text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.get_active_warmup_lines()',
    'public.get_line_health_data(uuid)',
    'public.warmup_daily_reset()',
    'public.warmup_record_activity(uuid,uuid,text,text,text,text,integer,boolean,boolean)',
    'public.warmup_record_activity(uuid,uuid,text,text,text,text,integer,boolean,boolean,integer,jsonb,text,integer)',
    'public.log_scoring_config_change()',
    'public.log_segmentation_tier_change()'
  ] LOOP
    target := to_regprocedure(signature);
    IF target IS NULL THEN CONTINUE; END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', target);
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', target, role_name);
        IF has_function_privilege(role_name, target, 'EXECUTE') THEN
          RAISE EXCEPTION 'Internal function % remains accessible to %', signature, role_name;
        END IF;
      END IF;
    END LOOP;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', target);
    END IF;
  END LOOP;
END
$migration$;
