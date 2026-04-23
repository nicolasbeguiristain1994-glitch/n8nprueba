-- Migration 019: Fix campaigns.updated_by type and add FK
-- Context: 018 found a pre-existing updated_by VARCHAR column on staging
-- and silently skipped (ADD COLUMN IF NOT EXISTS). Column is empty so
-- the USING cast is safe and the FK adds no risk.
-- Idempotent: safe to run multiple times.

-- 1. Drop the existing FK if it already exists (re-run safety)
DO $$ BEGIN
  ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_updated_by_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- 2a. Preflight: null out any values that are not valid UUIDs to prevent
--     the USING cast from throwing on unexpected non-UUID strings.
UPDATE campaigns
  SET updated_by = NULL
  WHERE updated_by IS NOT NULL
    AND updated_by !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- 2b. Retype varchar → uuid (safe: all remaining values are valid UUIDs or NULL)
ALTER TABLE campaigns
  ALTER COLUMN updated_by TYPE uuid USING updated_by::uuid;

-- 3. Add FK on updated_by matching owned_by pattern
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
