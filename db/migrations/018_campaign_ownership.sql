-- Migration 018: Campaign ownership tracking
-- Idempotent: safe to run multiple times

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS owned_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Queries that filter/join by owner (operator/viewer visibility)
CREATE INDEX IF NOT EXISTS idx_campaigns_owned_by   ON campaigns (owned_by);

-- Useful for audit queries ("who last updated this campaign?")
CREATE INDEX IF NOT EXISTS idx_campaigns_updated_by ON campaigns (updated_by);
