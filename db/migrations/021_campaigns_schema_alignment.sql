-- Migration 021: Align campaigns table with current app routes
--
-- Context: The campaigns table was created from init.sql which used a legacy schema
-- (template_id, scheduled_start_at, ended_at, total_contacts, etc.).  The app
-- routes were developed against a newer schema that was never migrated.  This
-- migration adds every column required by the current routes without touching or
-- renaming any existing column.
--
-- Idempotent: all ADD COLUMN statements use IF NOT EXISTS.
-- Does NOT drop, rename, or backfill existing columns.
-- Existing rows receive safe NOT NULL defaults where required.

-- ── Message content ────────────────────────────────────────────────────────────
-- message:  primary/first message text (msgArray[0] on insert)
-- messages: full rotation pool as JSONB array

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS message  TEXT,
  ADD COLUMN IF NOT EXISTS messages JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ── Media attachment ───────────────────────────────────────────────────────────

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS media_url  TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT;

-- ── List association ───────────────────────────────────────────────────────────

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS list_id UUID;

-- Named FK — idempotent DO block so re-runs are safe
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'campaigns'
      AND constraint_name = 'campaigns_list_id_fkey'
  ) THEN
    ALTER TABLE campaigns
      ADD CONSTRAINT campaigns_list_id_fkey
        FOREIGN KEY (list_id) REFERENCES contact_lists(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── Scheduling (new column names; legacy scheduled_start_at/ended_at are kept) ─

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- ── Counters ───────────────────────────────────────────────────────────────────
-- total_targets: seeded from contact_list_members count on send start
-- total_sent / total_failed: updated by syncCounters() during send loop
-- (GET route computes these live from whatsapp_messages; columns are write targets)

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS total_targets INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_sent    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_failed  INTEGER NOT NULL DEFAULT 0;

-- ── Antiblock delay ────────────────────────────────────────────────────────────

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS antiblock_delay_min INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS antiblock_delay_max INTEGER NOT NULL DEFAULT 8;

-- CHECK constraints (named; guarded DO blocks prevent duplicate-constraint errors)
-- Safe on existing rows: defaults (3, 8) satisfy all three conditions.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'campaigns'
      AND constraint_name = 'campaigns_antiblock_min_pos'
  ) THEN
    ALTER TABLE campaigns
      ADD CONSTRAINT campaigns_antiblock_min_pos
        CHECK (antiblock_delay_min >= 1);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'campaigns'
      AND constraint_name = 'campaigns_antiblock_max_pos'
  ) THEN
    ALTER TABLE campaigns
      ADD CONSTRAINT campaigns_antiblock_max_pos
        CHECK (antiblock_delay_max >= 1);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'campaigns'
      AND constraint_name = 'campaigns_antiblock_order'
  ) THEN
    ALTER TABLE campaigns
      ADD CONSTRAINT campaigns_antiblock_order
        CHECK (antiblock_delay_min <= antiblock_delay_max);
  END IF;
END $$;

-- ── personalize_name (added by migration 005; guard for fresh-install idempotency) ─

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS personalize_name BOOLEAN NOT NULL DEFAULT true;

-- ── Indexes ────────────────────────────────────────────────────────────────────
-- idx_campaigns_status already exists (from init.sql)
-- idx_campaigns_owned_by already exists (from migration 018)

CREATE INDEX IF NOT EXISTS idx_campaigns_list_id
  ON campaigns (list_id) WHERE list_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_at
  ON campaigns (scheduled_at) WHERE scheduled_at IS NOT NULL;
