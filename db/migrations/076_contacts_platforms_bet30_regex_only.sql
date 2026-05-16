-- Migration 076: Fix bet30 detection in contacts.platforms
--
-- Problem: migration 075 required EXISTS verification against casino_players for
-- bet30 detection. But casino_players only contains Zeus-platform players
-- (agents: bigwin, ofizeus, betcoin, royal, farabet), so bet30 players are not
-- in that table and the check always fails.
--
-- Fix: use regex-only detection for bet30 (suffix b/bt), same approach as zeus
-- (suffix z/zs/zeus). Removes the casino_players dependency entirely.

BEGIN;

-- ── 1. Update trigger function ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION compute_contact_platforms()
RETURNS trigger AS $$
BEGIN
  NEW.platforms := ARRAY_REMOVE(ARRAY[
    CASE WHEN NEW.first_name ~* 'z(s|eus)?$' OR NEW.last_name ~* 'z(s|eus)?$'
         THEN 'zeus' END,
    CASE WHEN NEW.first_name ~* 'b(t)?$' OR NEW.last_name ~* 'b(t)?$'
         THEN 'bet30' END
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
    id,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN first_name ~* 'z(s|eus)?$' OR last_name ~* 'z(s|eus)?$'
           THEN 'zeus' END,
      CASE WHEN first_name ~* 'b(t)?$' OR last_name ~* 'b(t)?$'
           THEN 'bet30' END
    ], NULL) AS new_platforms
  FROM contacts
) computed
WHERE c.id = computed.id
  AND c.platforms IS DISTINCT FROM computed.new_platforms;

COMMIT;
