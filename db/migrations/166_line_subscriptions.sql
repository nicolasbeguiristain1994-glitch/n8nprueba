-- Per-line subscriptions. An opt-in on one business line never grants another.
-- Apply before deploying the webhook and sending changes. Safe to reapply.
CREATE TABLE IF NOT EXISTS whatsapp_subscription_settings (
  line_id UUID PRIMARY KEY REFERENCES whatsapp_lines(id) ON DELETE CASCADE,
  brand_name TEXT NOT NULL CHECK (length(brand_name) BETWEEN 2 AND 100),
  message_text TEXT NOT NULL CHECK (length(message_text) BETWEEN 20 AND 1000),
  normalized_message TEXT NOT NULL,
  revision UUID NOT NULL DEFAULT gen_random_uuid(),
  enabled BOOLEAN NOT NULL DEFAULT true,
  active_since TIMESTAMPTZ NOT NULL DEFAULT date_trunc('second', NOW()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_subscription_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id UUID NOT NULL REFERENCES whatsapp_lines(id) ON DELETE CASCADE,
  contact_phone TEXT NOT NULL CHECK (contact_phone ~ '^[1-9][0-9]{6,14}$'),
  event TEXT NOT NULL CHECK (event IN ('subscribed', 'unsubscribed')),
  provider TEXT NOT NULL CHECK (provider IN ('cloud', 'evolution')),
  message_id TEXT NOT NULL,
  message_text TEXT NOT NULL,
  brand_name TEXT NOT NULL,
  revision UUID NOT NULL,
  expected_message TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (line_id, provider, message_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_subscription_events_history_idx
  ON whatsapp_subscription_events(line_id, occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS whatsapp_line_subscribers (
  line_id UUID NOT NULL REFERENCES whatsapp_lines(id) ON DELETE CASCADE,
  contact_phone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('subscribed', 'unsubscribed')),
  event_id UUID NOT NULL REFERENCES whatsapp_subscription_events(id),
  occurred_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (line_id, contact_phone)
);
CREATE INDEX IF NOT EXISTS whatsapp_line_subscribers_status_idx
  ON whatsapp_line_subscribers(line_id, status, occurred_at DESC, contact_phone);

-- Access is through the server's scoped API; no public client policies.
ALTER TABLE whatsapp_subscription_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_line_subscribers ENABLE ROW LEVEL SECURITY;
