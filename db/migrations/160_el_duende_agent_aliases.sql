-- Generated with Supabase CLI: 20261020222841_el_duende_agent_aliases.sql
-- Preserve existing account and consent rules; add the confirmed operator aliases.
CREATE OR REPLACE FUNCTION public.contact_agent_key(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT CASE lower(trim(value))
    WHEN 'btcuno' THEN 'betcoin' WHEN 'btcdos' THEN 'farabet'
    WHEN 'zeus' THEN 'ofizeus' WHEN 'zeusroyal' THEN 'royal'
    WHEN 'adminbtc' THEN 'betcoin' WHEN 'adminzeus' THEN 'ofizeus'
    WHEN 'adminroyal' THEN 'royal' WHEN 'admbigwin' THEN 'bigwin'
    WHEN 'adminfara' THEN 'farabet' WHEN 'amdfarabet' THEN 'farabet'
    WHEN 'facuadmin1' THEN 'elduende' WHEN 'duendeverde' THEN 'elduende'
    WHEN 'adminimperio' THEN 'imperio' ELSE NULLIF(lower(trim(value)),'') END
$$;
