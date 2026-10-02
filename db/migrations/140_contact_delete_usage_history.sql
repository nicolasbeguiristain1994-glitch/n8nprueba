-- A contact deletion cascades to campaign_recipients. Keep the line usage
-- history, clearing only its optional link to the deleted recipient.
ALTER TABLE line_usage_log
  DROP CONSTRAINT IF EXISTS line_usage_log_recipient_id_fkey,
  ADD CONSTRAINT line_usage_log_recipient_id_fkey
    FOREIGN KEY (recipient_id) REFERENCES campaign_recipients(id) ON DELETE SET NULL;
