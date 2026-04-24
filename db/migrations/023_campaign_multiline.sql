-- Migration 023: Multi-line campaign distribution
--
-- Extends the campaign system to distribute sends across multiple WhatsApp lines.
--
-- Source-of-truth decision: Option A — campaign_recipients is the single
-- authoritative record of each dispatch unit's lifecycle. No parallel table is
-- introduced. The existing status column (pending|sending|sent|failed|skipped)
-- covers the full dispatch lifecycle.
--
-- New fields:
--   campaign_recipients.line_id    — which line handled this recipient's send
--   campaigns.use_multi_line       — opt-in flag for multi-line distribution mode
--   whatsapp_lines.sending_enabled — per-line kill switch for campaign distribution
--
-- New table:
--   line_usage_log — lightweight append-only observability log per send attempt
--
-- Additive: no existing columns renamed, dropped, or type-changed.
-- Idempotent: all ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
--
-- Daily limit reset:
--   Counter reset is handled by the existing reset_line_counters_if_due() DB
--   function, called from WF-013 (n8n cron). No new reset mechanism is added.
--   Lines are not permanently blocked: counters reset on the next WF-013 run.
--
-- NOTE on null/non-null line_id behaviour (campaign_recipients.line_id):
--   NULL = not yet assigned to a line (pending/failed recipients awaiting retry)
--   Non-null = the line that last attempted / successfully sent this recipient


-- ── 1. campaign_recipients: add dispatch line tracking ─────────────────────────

ALTER TABLE campaign_recipients
  ADD COLUMN IF NOT EXISTS line_id UUID NULL REFERENCES whatsapp_lines(id);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_line_id
  ON campaign_recipients(line_id)
  WHERE line_id IS NOT NULL;


-- ── 2. campaigns: opt-in flag for multi-line distribution ─────────────────────

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS use_multi_line BOOLEAN NOT NULL DEFAULT false;


-- ── 3. whatsapp_lines: per-line campaign send enable/disable ──────────────────
--
-- sending_enabled = false excludes this line from multi-line campaign distribution
-- only. It does NOT affect chatbot, sequence, or ad-hoc sends via other routes.

ALTER TABLE whatsapp_lines
  ADD COLUMN IF NOT EXISTS sending_enabled BOOLEAN NOT NULL DEFAULT true;


-- ── 4. line_usage_log: append-only observability ──────────────────────────────
--
-- Records the outcome of each Evolution API call attempt made by the
-- multi-line distributor. Purely for visibility — campaign_recipients remains
-- the authoritative source of dispatch state.
--
-- status values: 'sent' | 'failed' | 'skipped'

CREATE TABLE IF NOT EXISTS line_usage_log (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  line_id       UUID        NOT NULL REFERENCES whatsapp_lines(id),
  campaign_id   UUID        NULL     REFERENCES campaigns(id),
  recipient_id  UUID        NULL     REFERENCES campaign_recipients(id),
  status        TEXT        NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error_code    TEXT        NULL,
  error_message TEXT        NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_line_usage_log_line_created
  ON line_usage_log(line_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_line_usage_log_campaign
  ON line_usage_log(campaign_id)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_line_usage_log_recipient
  ON line_usage_log(recipient_id)
  WHERE recipient_id IS NOT NULL;
