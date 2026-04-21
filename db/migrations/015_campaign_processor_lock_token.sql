-- 015 — campaign processor lock token
-- Adds processor_lock_token UUID to campaigns table for safe lock ownership.
-- The index speeds up stale-lock queries filtered on processor_locked_at.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS processor_lock_token UUID;

CREATE INDEX IF NOT EXISTS idx_campaigns_processor_lock
  ON campaigns(processor_locked_at)
  WHERE processor_locked_at IS NOT NULL;
