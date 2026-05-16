-- Migration 077: Comprehensive Zeus detection fix
--
-- Problems found in migration 076:
--   1. Regex 'z(s|eus)?$' missed 'ze' suffix (ze = Zeus, ~1,573 contacts)
--   2. Multi-username fields like "Claudia591z Pereyra" or "anita77bt // anita77ze"
--      were not detected because only the end of the whole field was checked.
--   3. 'f'/'ff' suffix contacts are Zeus (agent bigwin/royal in casino_players)
--      but regex can't reliably detect them (too many false positives).
--
-- Fix:
--   Zeus = regex z/ze/zs/zeus at end of FULL field
--          OR any token in the field exists in casino_players with a Zeus agent.
--          (This covers f/ff/zz users and multi-name fields.)
--   Bet30 = regex b/bt at end of FULL field (unchanged, no casino_players data)
--
-- The trigger skips the casino_players lookup when the Zeus regex already matched,
-- so plain Zeus contacts (ending z/ze/zs/zeus) incur no extra DB cost.

BEGIN;

-- ── 1. Update trigger function ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION compute_contact_platforms()
RETURNS trigger AS $$
DECLARE
  v_is_zeus boolean := false;
BEGIN
  -- Zeus: fast regex check first
  IF NEW.first_name ~* 'z(e|s|eus)?$' OR NEW.last_name ~* 'z(e|s|eus)?$' THEN
    v_is_zeus := true;
  ELSE
    -- Slower fallback: split field into tokens and check each against casino_players.
    -- Handles: 'f'/'ff' suffix users, multi-username fields like "User99z Lastname".
    -- Token separators: space, slash, backslash, comma, pipe, semicolon.
    SELECT EXISTS (
      SELECT 1
      FROM casino_players cp
      JOIN LATERAL unnest(
        regexp_split_to_array(
          COALESCE(NEW.first_name, '') || ' ' || COALESCE(NEW.last_name, ''),
          '[\s/\\|,;]+'
        )
      ) AS tok ON true
      WHERE LENGTH(tok) > 2
        AND cp.username_lower = LOWER(tok)
        AND cp.agente = ANY(ARRAY['bigwin','ofizeus','betcoin','royal','farabet'])
    ) INTO v_is_zeus;
  END IF;

  NEW.platforms := ARRAY_REMOVE(ARRAY[
    CASE WHEN v_is_zeus                                                               THEN 'zeus' END,
    CASE WHEN NEW.first_name ~* 'b(t)?$' OR NEW.last_name ~* 'b(t)?$' THEN 'bet30'  END
  ], NULL);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 2. Backfill: recompute all contacts with updated logic ─────────────────────
UPDATE contacts c
SET    platforms  = computed.new_platforms,
       updated_at = NOW()
FROM (
  SELECT
    c2.id,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN
        c2.first_name ~* 'z(e|s|eus)?$' OR c2.last_name ~* 'z(e|s|eus)?$'
        OR EXISTS (
          SELECT 1
          FROM casino_players cp
          JOIN LATERAL unnest(
            regexp_split_to_array(
              COALESCE(c2.first_name, '') || ' ' || COALESCE(c2.last_name, ''),
              '[\s/\\|,;]+'
            )
          ) AS tok ON true
          WHERE LENGTH(tok) > 2
            AND cp.username_lower = LOWER(tok)
            AND cp.agente = ANY(ARRAY['bigwin','ofizeus','betcoin','royal','farabet'])
        )
      THEN 'zeus' END,
      CASE WHEN c2.first_name ~* 'b(t)?$' OR c2.last_name ~* 'b(t)?$' THEN 'bet30' END
    ], NULL) AS new_platforms
  FROM contacts c2
) computed
WHERE c.id = computed.id
  AND c.platforms IS DISTINCT FROM computed.new_platforms;

COMMIT;
