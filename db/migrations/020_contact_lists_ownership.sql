-- Migration 020: Contact list ownership tracking
-- Mirrors campaigns migration 018/019: adds owned_by/updated_by FK columns.
-- Idempotent: safe to run multiple times.
-- No backfill — existing rows stay owned_by IS NULL (admin-only visibility).

ALTER TABLE contact_lists
  ADD COLUMN IF NOT EXISTS owned_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Queries that filter by owner (operator/viewer visibility)
CREATE INDEX IF NOT EXISTS idx_contact_lists_owned_by   ON contact_lists (owned_by);

-- Useful for audit queries ("who last updated this list?")
CREATE INDEX IF NOT EXISTS idx_contact_lists_updated_by ON contact_lists (updated_by);
