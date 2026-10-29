-- Generated with Supabase CLI: 20261029153336_agent_247_alias.sql
-- 24/7 uses Admin99 in Zeus, Bet30 and Ganamos; no Argenbet account.
CREATE OR REPLACE FUNCTION public.contact_agent_key(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT CASE lower(trim(value))
    WHEN 'btcuno' THEN 'betcoin' WHEN 'btcdos' THEN 'farabet'
    WHEN 'zeus' THEN 'ofizeus' WHEN 'zeusroyal' THEN 'royal'
    WHEN 'adminbtc' THEN 'betcoin' WHEN 'adminzeus' THEN 'ofizeus'
    WHEN 'adminroyal' THEN 'royal' WHEN 'admbigwin' THEN 'bigwin'
    WHEN 'adminfara' THEN 'farabet' WHEN 'amdfarabet' THEN 'farabet'
    WHEN 'admin99' THEN '247' WHEN 'facuadmin1' THEN 'elduende' WHEN 'duendeverde' THEN 'elduende'
    WHEN 'adminimperio' THEN 'imperio' ELSE NULLIF(lower(trim(value)),'') END
$$;
