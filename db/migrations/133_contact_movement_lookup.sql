-- Deterministic identity search keys, not cached financial data. PostgreSQL
-- maintains the expression index on every contact name/account update.
CREATE OR REPLACE FUNCTION contact_movement_names(first_name text,last_name text,accounts jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT username),'{}') FROM (
    SELECT lower(trim(a->>'username')) username FROM jsonb_array_elements(coalesce(accounts,'[]')) a
    UNION SELECT lower(tok) FROM regexp_split_to_table(coalesce(first_name,'') || ' ' || coalesce(last_name,''),'[^a-zA-Z0-9_]+') tok WHERE length(tok)>=4
  ) names WHERE username IS NOT NULL;
$$;
-- Run outside a transaction so production reads and writes remain available.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_movement_names
  ON contacts USING gin(contact_movement_names(first_name,last_name,casino_accounts))
  WHERE deleted_at IS NULL;
