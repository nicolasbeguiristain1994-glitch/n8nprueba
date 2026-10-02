-- Persistent campaign routing. NULL line_id is a deleted sender, never permission
-- to silently switch numbers. The zero UUID isolates ownerless system campaigns.
CREATE TABLE IF NOT EXISTS campaign_line_assignments (
  owner_key UUID NOT NULL,
  phone TEXT NOT NULL,
  line_id UUID REFERENCES whatsapp_lines(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('history', 'rotation')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_key, phone)
);
CREATE TABLE IF NOT EXISTS campaign_line_rotation (
  owner_key UUID PRIMARY KEY,
  next_position BIGINT NOT NULL DEFAULT 0
);
ALTER TABLE campaign_line_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_line_rotation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campaign_line_assignments, campaign_line_rotation FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON campaign_line_assignments, campaign_line_rotation FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON campaign_line_assignments, campaign_line_rotation FROM authenticated;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cr_routing_phone
  ON campaign_recipients ((regexp_replace(phone_number, '[^0-9]', '', 'g')))
  WHERE line_id IS NOT NULL AND status = 'sent';
CREATE INDEX IF NOT EXISTS idx_cloud_conv_routing_phone
  ON cloud_conversations ((regexp_replace(contact_phone, '[^0-9]', '', 'g')));

ALTER TABLE campaigns ALTER COLUMN use_multi_line SET DEFAULT true;
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_pause_reason_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_pause_reason_check CHECK (pause_reason IN (
  'manual', 'no_eligible_lines', 'all_lines_outside_schedule', 'systemic_error',
  'config_missing', 'frequency_exhausted', 'unknown', 'assigned_line_unavailable'
));
