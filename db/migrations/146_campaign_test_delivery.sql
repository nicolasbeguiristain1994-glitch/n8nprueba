SET LOCAL lock_timeout = '5s';

ALTER TABLE campaign_test_sends ADD COLUMN IF NOT EXISTS phone_number_id text;
ALTER TABLE campaign_test_sends ADD COLUMN IF NOT EXISTS delivery_error_code integer;
ALTER TABLE campaign_test_sends ADD COLUMN IF NOT EXISTS delivery_updated_at timestamptz;
ALTER TABLE campaign_test_sends DROP CONSTRAINT IF EXISTS campaign_test_sends_status_check;
ALTER TABLE campaign_test_sends ADD CONSTRAINT campaign_test_sends_status_check
  CHECK (status IN ('sending','sent','delivered','read','failed','uncertain'));

-- Recover the sender identifier only when the line has one unambiguous mapping.
-- This supplies correlation metadata, never an inferred delivery status.
UPDATE campaign_test_sends t SET phone_number_id=cn.phone_number_id
FROM (SELECT whatsapp_line_id,MIN(phone_number_id) AS phone_number_id FROM cloud_numbers
      GROUP BY whatsapp_line_id HAVING COUNT(DISTINCT phone_number_id)=1) cn
WHERE t.line_id=cn.whatsapp_line_id AND t.phone_number_id IS NULL;
CREATE INDEX IF NOT EXISTS campaign_test_sends_provider_idx
  ON campaign_test_sends(phone_number_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS campaign_test_sends_pending_sender_idx
  ON campaign_test_sends(phone_number_id,created_at)
  WHERE provider_message_id IS NULL AND status IN ('sending','uncertain');

-- A callback can arrive before the HTTP send response exposes its WAMID. Keep
-- one durable, monotonic receipt per sender/WAMID until it can be correlated.
-- The application stores known test WAMIDs or a sender's short in-flight test window.
CREATE TABLE IF NOT EXISTS campaign_test_delivery_receipts (
  phone_number_id text NOT NULL,
  provider_message_id text NOT NULL,
  recipient_phone text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent','delivered','read','failed')),
  occurred_at timestamptz NOT NULL,
  error_code integer,
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (phone_number_id,provider_message_id)
);
ALTER TABLE campaign_test_delivery_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campaign_test_delivery_receipts FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=api_role) THEN
      EXECUTE format('REVOKE ALL ON campaign_test_delivery_receipts FROM %I',api_role);
    END IF;
  END LOOP;
END $$;
