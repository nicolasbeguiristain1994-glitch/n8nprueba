-- Phase 3: Campaign durability — index for stale-lock recovery and ordered claiming

-- Partial index: efficiently find pending rows for the background processor
-- (already exists in 008, but adding the locked_at column for stale recovery queries)
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_stale
  ON campaign_recipients(campaign_id, locked_at)
  WHERE status = 'sending';
