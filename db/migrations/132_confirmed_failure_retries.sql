-- Preserve old attempts while releasing frequency only for confirmed failures.
-- Additive and compatible with the previous application version.
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS original_campaign_recipient_id UUID;
ALTER TABLE contact_send_history ADD COLUMN IF NOT EXISTS original_campaign_recipient_id UUID;
ALTER TABLE contact_send_history ADD COLUMN IF NOT EXISTS frequency_released_at TIMESTAMPTZ;
ALTER TABLE contact_send_history ADD COLUMN IF NOT EXISTS failed_message_id UUID;
CREATE INDEX IF NOT EXISTS idx_contact_history_failed_message ON contact_send_history(failed_message_id)
  WHERE failed_message_id IS NOT NULL;
COMMENT ON COLUMN whatsapp_messages.original_campaign_recipient_id IS
  'Recipient of an archived failed attempt; campaign_recipient_id belongs only to the current attempt.';
COMMENT ON COLUMN contact_send_history.frequency_released_at IS
  'Confirmed failure: keep the attempt for audit, exclude it from frequency until delivery evidence restores it.';
