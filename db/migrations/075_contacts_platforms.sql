-- Migration 075: Persistent `platforms` column on contacts
--
-- Stores the detected casino platforms for each contact (e.g. ['zeus'], ['bet30'],
-- ['zeus','bet30']). Maintained automatically via trigger on first_name/last_name changes.
--
-- After running a casino sync that adds new bet30 players, refresh all contacts with:
--   POST /api/contacts/recompute-platforms   (admin-only)
--
-- IMPORTANT: The bet30 agent list below must stay in sync with
--   PLATFORM_AGENTS.bet30 in frontend/lib/casino-agents.ts.
--   Update both places when adding or removing Bet30 agents.

BEGIN;

-- ── 1. Column ─────────────────────────────────────────────────────────────────
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS platforms text[] NOT NULL DEFAULT '{}';

-- ── 2. Trigger function ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION compute_contact_platforms()
RETURNS trigger AS $$
DECLARE
  v_candidates text[];
  v_is_bet30   boolean := false;
BEGIN
  -- Bet30 check: only hit casino_players when the username regex matches,
  -- avoiding an unnecessary EXISTS for every Zeus / unclassified contact.
  IF (NEW.first_name ~* 'b(t)?$' OR NEW.last_name ~* 'b(t)?$') THEN
    v_candidates := ARRAY[
      LOWER(TRIM(COALESCE(NEW.first_name, ''))),
      REGEXP_REPLACE(LOWER(TRIM(COALESCE(NEW.first_name, ''))), '^[a-z]+/\s*', ''),
      LOWER(TRIM(COALESCE(NEW.last_name,  ''))),
      REGEXP_REPLACE(LOWER(TRIM(COALESCE(NEW.last_name,  ''))), '^[a-z]+/\s*', '')
    ];

    SELECT EXISTS(
      SELECT 1 FROM casino_players cp
      WHERE cp.username_lower = ANY(v_candidates)
        -- Mirrors PLATFORM_AGENTS.bet30 in frontend/lib/casino-agents.ts
        AND cp.agente = ANY(ARRAY['bigwin','zeus','zeusroyal','btcuno','btcdos'])
    ) INTO v_is_bet30;
  END IF;

  NEW.platforms := ARRAY_REMOVE(ARRAY[
    CASE WHEN NEW.first_name ~* 'z(s|eus)?$' OR NEW.last_name ~* 'z(s|eus)?$'
         THEN 'zeus' END,
    CASE WHEN v_is_bet30
         THEN 'bet30' END
  ], NULL);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 3. Trigger ────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_contact_platforms ON contacts;
CREATE TRIGGER trg_contact_platforms
  BEFORE INSERT OR UPDATE OF first_name, last_name
  ON contacts
  FOR EACH ROW EXECUTE FUNCTION compute_contact_platforms();

-- ── 4. GIN index — fast `'bet30' = ANY(platforms)` / `'zeus' = ANY(platforms)` ──
CREATE INDEX IF NOT EXISTS idx_contacts_platforms_gin
  ON contacts USING gin(platforms);

-- ── 5. Backfill existing contacts ─────────────────────────────────────────────
-- Computes platforms for all rows already in the table (trigger only fires on
-- future INSERTs/UPDATEs). Only updates rows where the value actually changes.
UPDATE contacts c
SET    platforms = computed.new_platforms
FROM (
  SELECT
    id,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN first_name ~* 'z(s|eus)?$' OR last_name ~* 'z(s|eus)?$'
           THEN 'zeus' END,
      CASE WHEN (first_name ~* 'b(t)?$' OR last_name ~* 'b(t)?$')
           AND EXISTS (
             SELECT 1 FROM casino_players cp
             WHERE cp.username_lower = ANY(ARRAY[
               LOWER(TRIM(COALESCE(first_name, ''))),
               REGEXP_REPLACE(LOWER(TRIM(COALESCE(first_name, ''))), '^[a-z]+/\s*', ''),
               LOWER(TRIM(COALESCE(last_name,  ''))),
               REGEXP_REPLACE(LOWER(TRIM(COALESCE(last_name,  ''))), '^[a-z]+/\s*', '')
             ])
             AND cp.agente = ANY(ARRAY['bigwin','zeus','zeusroyal','btcuno','btcdos'])
           )
           THEN 'bet30' END
    ], NULL) AS new_platforms
  FROM contacts
) computed
WHERE c.id = computed.id
  AND c.platforms IS DISTINCT FROM computed.new_platforms;

COMMIT;
