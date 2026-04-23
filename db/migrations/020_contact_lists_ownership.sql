-- Migration 020: Contact list ownership tracking
-- Mirrors campaigns migration 018/019: adds owned_by/updated_by FK columns.
-- Idempotent: safe to run multiple times.
-- No backfill — existing rows stay owned_by IS NULL (admin-only visibility).

-- Preflight: guard against an existing column with a wrong type.
-- If either column already exists but is NOT uuid, abort with a clear message
-- rather than silently skipping (ADD COLUMN IF NOT EXISTS would hide the issue).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contact_lists' AND column_name = 'owned_by'
      AND data_type != 'uuid'
  ) THEN
    RAISE EXCEPTION 'contact_lists.owned_by already exists but is not UUID type — manual intervention required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contact_lists' AND column_name = 'updated_by'
      AND data_type != 'uuid'
  ) THEN
    RAISE EXCEPTION 'contact_lists.updated_by already exists but is not UUID type — manual intervention required';
  END IF;
END $$;

ALTER TABLE contact_lists
  ADD COLUMN IF NOT EXISTS owned_by   UUID,
  ADD COLUMN IF NOT EXISTS updated_by UUID;

-- Named FK constraints so they can be dropped/re-added without guessing names.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'contact_lists' AND constraint_name = 'contact_lists_owned_by_fkey'
  ) THEN
    ALTER TABLE contact_lists
      ADD CONSTRAINT contact_lists_owned_by_fkey
        FOREIGN KEY (owned_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'contact_lists' AND constraint_name = 'contact_lists_updated_by_fkey'
  ) THEN
    ALTER TABLE contact_lists
      ADD CONSTRAINT contact_lists_updated_by_fkey
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Queries that filter by owner (operator/viewer visibility)
CREATE INDEX IF NOT EXISTS idx_contact_lists_owned_by   ON contact_lists (owned_by);

-- Useful for audit queries ("who last updated this list?")
CREATE INDEX IF NOT EXISTS idx_contact_lists_updated_by ON contact_lists (updated_by);
