-- Phase 3b: Campaign durability — idempotency key + processor lock

-- 1. campaign_recipient_id on whatsapp_messages
--    Ties each outbound campaign message to the exact campaign_recipients row
--    so we can: (a) prevent duplicate sends via unique constraint,
--    (b) detect send confirmation during stale recovery via direct FK lookup.
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS campaign_recipient_id UUID
  REFERENCES campaign_recipients(id) ON DELETE SET NULL;

-- Partial unique index: one outbound whatsapp_messages row per campaign recipient.
-- DO NOT apply to inbound or non-campaign messages (campaign_recipient_id IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_campaign_recipient_dedup
  ON whatsapp_messages(campaign_recipient_id)
  WHERE campaign_recipient_id IS NOT NULL;

-- 2. processor_locked_at on campaigns
--    Tracks which instance/invocation holds the processor.
--    Stale timeout (30 min) auto-expires crashed processors.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS processor_locked_at TIMESTAMPTZ;
