-- Fix 4: Campaign recipients table for idempotent sends and per-contact state tracking

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id                   UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id          UUID        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id           UUID        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  phone_number         TEXT        NOT NULL,
  message_body         TEXT,
  status               TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending','sending','sent','failed','skipped')),
  evolution_message_id TEXT,
  error_detail         TEXT,
  attempts             INT         NOT NULL DEFAULT 0,
  locked_at            TIMESTAMPTZ,
  sent_at              TIMESTAMPTZ,
  failed_at            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign
  ON campaign_recipients(campaign_id, status);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_pending
  ON campaign_recipients(campaign_id, created_at)
  WHERE status = 'pending';
