-- Admin-owned test destinations and an immutable send-attempt ledger.
-- Tests do not reset contact frequency history or mutate campaign recipients.
BEGIN;
CREATE TABLE IF NOT EXISTS campaign_test_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name text NOT NULL CHECK (length(btrim(first_name)) BETWEEN 1 AND 100),
  phone_number text NOT NULL UNIQUE CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$'),
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS campaign_test_sends (
  id uuid PRIMARY KEY, -- client request ID: retries must reuse it
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  recipient_id uuid NOT NULL REFERENCES campaign_test_recipients(id),
  line_id uuid REFERENCES whatsapp_lines(id) ON DELETE SET NULL,
  sent_by uuid REFERENCES users(id) ON DELETE SET NULL,
  first_name text NOT NULL,
  phone_number text NOT NULL,
  line_name text NOT NULL,
  template_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','failed','uncertain')),
  provider_message_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_test_sends_campaign_idx ON campaign_test_sends(campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campaign_test_sends_recipient_idx ON campaign_test_sends(recipient_id, created_at DESC);
ALTER TABLE campaign_test_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_test_sends ENABLE ROW LEVEL SECURITY;
-- API access is server-only, including on databases with Supabase default grants.
REVOKE ALL ON campaign_test_recipients, campaign_test_sends FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=api_role) THEN
      EXECUTE format('REVOKE ALL ON campaign_test_recipients, campaign_test_sends FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
COMMIT;
