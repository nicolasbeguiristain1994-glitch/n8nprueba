-- Source: 20261020010335_campaign_risk_whatsapp_alerts.sql (Supabase CLI 2.121.0).
SET LOCAL lock_timeout = '5s';

-- One WhatsApp notice per unresolved pause episode and configured destination.
-- Recipient/sender configuration lives only in server environment variables.
CREATE TABLE IF NOT EXISTS campaign_risk_whatsapp_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES campaign_risk_incidents(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  destination text NOT NULL CHECK (destination ~ '^\+[1-9][0-9]{6,14}$'),
  phone_number_id text NOT NULL,
  template_name text NOT NULL,
  template_language text NOT NULL,
  template_id text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','preparing','sending','sent','delivered','read','blocked','failed','uncertain','skipped')),
  detail_code text,
  attempt_token uuid,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  provider_message_id text,
  delivery_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id,destination)
);
CREATE INDEX IF NOT EXISTS campaign_risk_whatsapp_alerts_due_idx
  ON campaign_risk_whatsapp_alerts(next_attempt_at,created_at,id) WHERE status IN ('pending','blocked');
CREATE INDEX IF NOT EXISTS campaign_risk_whatsapp_alerts_campaign_idx ON campaign_risk_whatsapp_alerts(campaign_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_risk_whatsapp_alerts_provider_idx
  ON campaign_risk_whatsapp_alerts(phone_number_id,provider_message_id) WHERE provider_message_id IS NOT NULL;

-- Keep verified callbacks that race ahead of the HTTP response exposing WAMID.
CREATE TABLE IF NOT EXISTS campaign_risk_whatsapp_receipts (
  phone_number_id text NOT NULL,
  provider_message_id text NOT NULL,
  recipient_phone text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent','delivered','read','failed')),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(phone_number_id,provider_message_id)
);
ALTER TABLE campaign_risk_whatsapp_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_risk_whatsapp_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campaign_risk_whatsapp_alerts,campaign_risk_whatsapp_receipts FROM PUBLIC;
DO $$ DECLARE api_role text; BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=api_role) THEN
      EXECUTE format('REVOKE ALL ON campaign_risk_whatsapp_alerts,campaign_risk_whatsapp_receipts FROM %I',api_role);
    END IF;
  END LOOP;
END $$;
