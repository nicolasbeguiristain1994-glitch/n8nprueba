-- Migration 011: Ensure contacts.phone_number has a UNIQUE index
-- Purpose: contacts/import/route.ts uses ON CONFLICT (phone_number) DO UPDATE.
--          Without a unique index/constraint on that column the ON CONFLICT clause
--          fails with "there is no unique or exclusion constraint matching the ON CONFLICT
--          specification".
--
-- PREFLIGHT: run this query first to check for existing duplicates.
-- If it returns rows, deduplicate manually before applying this migration.
--
--   SELECT phone_number, COUNT(*)
--   FROM contacts
--   GROUP BY phone_number
--   HAVING COUNT(*) > 1;
--
-- This migration will FAIL CLEARLY if duplicates exist (CREATE UNIQUE INDEX raises
-- an error on conflicting rows — it does NOT silently drop data).

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_phone_unique
  ON contacts(phone_number);
