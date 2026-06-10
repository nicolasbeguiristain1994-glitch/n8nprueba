-- Migration 112: Fix platforms detection for multi-username fields and digit suffixes
--
-- Problems:
--   1. Zeus regex 'z(e|s|eus)?$' misses usernames with trailing digits:
--      "Mario46z3" ends with 'z3', not 'z' → platforms stayed '{}'
--   2. Bet30 regex 'b(t)?$' misses 'be' suffix:
--      "mario46be" ends with 'be', not 'b'/'bt' → not detected as bet30
--   3. Multi-username fields like "(C.MUCHO)Mario46z3/mario46be" require checking
--      each token individually, not just the full field end.
--   4. Parenthesized prefixes like "(C.MUCHO)" broke casino_players token lookup.
--
-- Fix:
--   Zeus  = full-field regex z/ze/zs/zeus + optional trailing digits
--           OR per-token regex (handles multi-name, strips parenthesized prefixes)
--           OR per-token casino_players lookup (f/ff suffix users)
--   Bet30 = full-field regex b/bt/be + optional trailing digits
--           OR per-token regex (handles multi-name, strips parenthesized prefixes)

BEGIN;

CREATE OR REPLACE FUNCTION compute_contact_platforms()
RETURNS trigger AS $$
DECLARE
  v_is_zeus  boolean := false;
  v_is_bet30 boolean := false;
  v_full     text;
BEGIN
  v_full := COALESCE(NEW.first_name, '') || ' ' || COALESCE(NEW.last_name, '');

  -- ── Zeus detection ────────────────────────────────────────────────────────────
  -- 1. Fast: regex on full field (now includes optional trailing digits after suffix)
  IF v_full ~* 'z(e|s|eus)?\d*$' THEN
    v_is_zeus := true;
  ELSE
    -- 2. Per-token regex: handles "(C.MUCHO)Mario46z3/mario46be" where zeus token
    --    is not at the end of the full field. Strips parenthesized prefix from token.
    SELECT EXISTS (
      SELECT 1 FROM unnest(regexp_split_to_array(v_full, '[\s/\\|,;]+')) AS tok
      WHERE LENGTH(REGEXP_REPLACE(LOWER(tok), '^\([^)]*\)', '')) > 2
        AND REGEXP_REPLACE(LOWER(tok), '^\([^)]*\)', '') ~* 'z(e|s|eus)?\d*$'
    ) INTO v_is_zeus;

    -- 3. casino_players fallback for f/ff suffix users not caught by regex
    IF NOT v_is_zeus THEN
      SELECT EXISTS (
        SELECT 1
        FROM casino_players cp
        JOIN LATERAL unnest(regexp_split_to_array(v_full, '[\s/\\|,;]+')) AS tok ON true
        WHERE LENGTH(tok) > 2
          AND cp.username_lower = REGEXP_REPLACE(LOWER(tok), '^\([^)]*\)', '')
          AND cp.agente = ANY(ARRAY['bigwin','ofizeus','betcoin','royal','farabet'])
      ) INTO v_is_zeus;
    END IF;
  END IF;

  -- ── Bet30 detection (regex only — no casino_players table for bet30) ──────────
  -- 1. Fast: regex on full field (b/bt/be + optional trailing digits)
  IF v_full ~* 'b(t|e)?\d*$' THEN
    v_is_bet30 := true;
  ELSE
    -- 2. Per-token regex: handles multi-username fields where bet30 token is not
    --    at the end of the full field (e.g. "Mario46z3/mario46be" ends in zeus part).
    SELECT EXISTS (
      SELECT 1 FROM unnest(regexp_split_to_array(v_full, '[\s/\\|,;]+')) AS tok
      WHERE LENGTH(REGEXP_REPLACE(LOWER(tok), '^\([^)]*\)', '')) > 2
        AND REGEXP_REPLACE(LOWER(tok), '^\([^)]*\)', '') ~* 'b(t|e)?\d*$'
    ) INTO v_is_bet30;
  END IF;

  NEW.platforms := ARRAY_REMOVE(ARRAY[
    CASE WHEN v_is_zeus  THEN 'zeus'  END,
    CASE WHEN v_is_bet30 THEN 'bet30' END
  ], NULL);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Backfill: recompute all contacts with updated logic ───────────────────────
UPDATE contacts c
SET    platforms  = computed.new_platforms,
       updated_at = NOW()
FROM (
  WITH tokens AS (
    SELECT
      id,
      COALESCE(first_name, '') || ' ' || COALESCE(last_name, '') AS full_name
    FROM contacts
  ),
  per_token AS (
    SELECT
      t.id,
      REGEXP_REPLACE(LOWER(tok), '^\([^)]*\)', '') AS clean_tok
    FROM tokens t
    JOIN LATERAL unnest(regexp_split_to_array(t.full_name, '[\s/\\|,;]+')) AS tok ON true
    WHERE LENGTH(tok) > 2
  )
  SELECT
    t.id,
    ARRAY_REMOVE(ARRAY[
      -- Zeus: full-field regex OR per-token regex OR casino_players lookup
      CASE WHEN
        t.full_name ~* 'z(e|s|eus)?\d*$'
        OR EXISTS (SELECT 1 FROM per_token pt WHERE pt.id = t.id AND pt.clean_tok ~* 'z(e|s|eus)?\d*$')
        OR EXISTS (
          SELECT 1 FROM casino_players cp
          JOIN per_token pt ON pt.id = t.id AND cp.username_lower = pt.clean_tok
          WHERE cp.agente = ANY(ARRAY['bigwin','ofizeus','betcoin','royal','farabet'])
        )
      THEN 'zeus' END,
      -- Bet30: full-field regex OR per-token regex
      CASE WHEN
        t.full_name ~* 'b(t|e)?\d*$'
        OR EXISTS (SELECT 1 FROM per_token pt WHERE pt.id = t.id AND pt.clean_tok ~* 'b(t|e)?\d*$')
      THEN 'bet30' END
    ], NULL) AS new_platforms
  FROM tokens t
) computed
WHERE c.id = computed.id
  AND c.platforms IS DISTINCT FROM computed.new_platforms;

COMMIT;
