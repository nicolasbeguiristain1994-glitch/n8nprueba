-- Optional double opt-in. Existing lines keep their current behavior.
ALTER TABLE whatsapp_subscription_settings ADD COLUMN IF NOT EXISTS confirmation_flow JSONB;
ALTER TABLE whatsapp_subscription_events ADD COLUMN IF NOT EXISTS request_event_id UUID REFERENCES whatsapp_subscription_events(id);
CREATE INDEX IF NOT EXISTS whatsapp_subscription_events_request_idx ON whatsapp_subscription_events(request_event_id) WHERE request_event_id IS NOT NULL;
ALTER TABLE whatsapp_subscription_events DROP CONSTRAINT IF EXISTS whatsapp_subscription_events_event_check;
ALTER TABLE whatsapp_subscription_events ADD CONSTRAINT whatsapp_subscription_events_event_check CHECK(event IN ('pending','subscribed','unsubscribed'));
ALTER TABLE whatsapp_line_subscribers DROP CONSTRAINT IF EXISTS whatsapp_line_subscribers_status_check;
ALTER TABLE whatsapp_line_subscribers ADD CONSTRAINT whatsapp_line_subscribers_status_check CHECK(status IN ('pending','subscribed','unsubscribed'));

-- Also remembers an OK received without a pending request: replaying it later
-- must never turn an unrelated conversation into consent.
CREATE TABLE IF NOT EXISTS whatsapp_subscription_flow_receipts (
  line_id UUID NOT NULL REFERENCES whatsapp_lines(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  handled BOOLEAN NOT NULL,
  event_id UUID REFERENCES whatsapp_subscription_events(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(line_id,message_id)
);
CREATE TABLE IF NOT EXISTS whatsapp_subscription_replies (
  event_id UUID PRIMARY KEY REFERENCES whatsapp_subscription_events(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4096),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','uncertain','skipped')),
  message_id UUID,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
ALTER TABLE whatsapp_subscription_flow_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_subscription_replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whatsapp_subscription_flow_receipts,whatsapp_subscription_replies FROM PUBLIC;
