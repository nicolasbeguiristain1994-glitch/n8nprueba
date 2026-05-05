-- Fix FK constraints so whatsapp_lines rows can be deleted cleanly.
--
-- campaign_recipients.line_id   → SET NULL  (keep historical record, lose line ref)
-- line_usage_log.line_id        → CASCADE   (log entries are meaningless without the line)

-- campaign_recipients
ALTER TABLE campaign_recipients
  DROP CONSTRAINT IF EXISTS campaign_recipients_line_id_fkey;
ALTER TABLE campaign_recipients
  ADD CONSTRAINT campaign_recipients_line_id_fkey
  FOREIGN KEY (line_id) REFERENCES whatsapp_lines(id) ON DELETE SET NULL;

-- line_usage_log
ALTER TABLE line_usage_log
  DROP CONSTRAINT IF EXISTS line_usage_log_line_id_fkey;
ALTER TABLE line_usage_log
  ADD CONSTRAINT line_usage_log_line_id_fkey
  FOREIGN KEY (line_id) REFERENCES whatsapp_lines(id) ON DELETE CASCADE;
