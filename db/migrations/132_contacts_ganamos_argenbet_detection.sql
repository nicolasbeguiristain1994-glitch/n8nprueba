-- Complete platform discovery for contact filters without inventing account
-- links, balances or levels. Explicit account platforms override name hints.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION contact_additional_platforms(first_name text, last_name text, accounts jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH names AS (
    SELECT coalesce(first_name,'') || ' ' || coalesce(last_name,'') AS name
    UNION ALL
    SELECT a->>'username' FROM jsonb_array_elements(coalesce(accounts,'[]')) a
  ), tokens AS (
    SELECT DISTINCT lower(trim(tok)) AS username
    FROM names CROSS JOIN LATERAL regexp_split_to_table(
      regexp_replace(name, '\([^)]*\)', ' ', 'g'), '[[:space:]/\\|,;]+') tok
  ), hints AS (
    SELECT username, CASE
      WHEN username ~ '^[a-z][a-z0-9_.-]*[0-9](g|ga|gs|gg|ggg|gggg|gaa|gaaa|ggs|ggss|gss|gsss|gga|gas|gan|gana|ganamos)[0-9]*$' THEN 'ganamos'
      WHEN username ~ '^[a-z][a-z0-9_.-]*[0-9](a|ar|arg|aa|aaa|aar|arge|argen|ars)[0-9]*$' THEN 'argenbet'
    END AS platform FROM tokens
  )
  SELECT coalesce(array_agg(DISTINCT platform ORDER BY platform), '{}') FROM hints h
  WHERE platform IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(coalesce(accounts,'[]')) a
    WHERE lower(trim(a->>'username'))=h.username
      AND a->>'platform' IN ('zeus','bet30','ganamos','argenbet')
  );
$$;

CREATE OR REPLACE FUNCTION preserve_explicit_casino_platforms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.platforms := ARRAY(SELECT DISTINCT p FROM (
    SELECT unnest(coalesce(NEW.platforms,'{}')) AS p
    UNION SELECT a->>'platform' FROM jsonb_array_elements(coalesce(NEW.casino_accounts,'[]')) a
      WHERE a->>'platform' IN ('zeus','bet30','ganamos','argenbet')
    UNION SELECT unnest(contact_additional_platforms(NEW.first_name,NEW.last_name,NEW.casino_accounts))
  ) all_platforms WHERE p IS NOT NULL ORDER BY p);
  RETURN NEW;
END;
$$;

-- Preserve existing Zeus/Bet30 markers and all financial/segmentation fields.
WITH detected AS MATERIALIZED (
  SELECT id,contact_additional_platforms(first_name,last_name,casino_accounts) extra
  FROM contacts WHERE deleted_at IS NULL
)
UPDATE contacts c SET platforms=coalesce(c.platforms,'{}') || d.extra
FROM detected d WHERE c.id=d.id AND NOT coalesce(c.platforms,'{}') @> d.extra;
COMMIT;
