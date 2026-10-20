-- Generated with Supabase CLI migration new; numbered for the verified release catalog.
CREATE TABLE IF NOT EXISTS campaign_risk_signals (
  scope_type text NOT NULL CHECK (scope_type IN ('campaign','waba','phone','template')),
  scope_id text NOT NULL,
  signal text NOT NULL,
  source text NOT NULL CHECK (source IN ('meta','panel')),
  signal_active boolean NOT NULL DEFAULT true,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  title text NOT NULL,
  detail text NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(scope_type,scope_id,signal)
);
CREATE TABLE IF NOT EXISTS campaign_risk_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('campaign','waba','phone','template')),
  scope_id text NOT NULL,
  signal text NOT NULL,
  source text NOT NULL CHECK (source IN ('meta','panel')),
  title text NOT NULL,
  detail text NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  review_note text
);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_risk_incident_open
  ON campaign_risk_incidents(campaign_id,scope_type,scope_id,signal) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS campaign_risk_review_time
  ON campaign_risk_incidents(campaign_id,resolved_at DESC) WHERE resolved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS campaign_risk_active_signal
  ON campaign_risk_signals(scope_type,scope_id) WHERE signal_active;
CREATE UNIQUE INDEX IF NOT EXISTS notification_risk_incident_user
  ON notifications(user_id,(metadata->>'risk_incident_id')) WHERE metadata ? 'risk_incident_id';
ALTER TABLE cloud_numbers ADD COLUMN IF NOT EXISTS risk_checked_at timestamptz;
ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS risk_checked_at timestamptz;
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_pause_reason_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_pause_reason_check CHECK (pause_reason IN (
 'manual','no_eligible_lines','all_lines_outside_schedule','systemic_error','config_missing',
 'frequency_exhausted','unknown','assigned_line_unavailable','risk_detected'
));
ALTER TABLE campaign_risk_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_risk_incidents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campaign_risk_signals,campaign_risk_incidents FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON campaign_risk_signals,campaign_risk_incidents FROM anon;
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN
  REVOKE ALL ON campaign_risk_signals,campaign_risk_incidents FROM authenticated;
 END IF;
END $$;
