-- Durable inbound deduplication and delayed automation steps. No rules enabled.
BEGIN;
CREATE TABLE IF NOT EXISTS automation_inbound_receipts (
 event_key text PRIMARY KEY, phone text NOT NULL, provider text NOT NULL CHECK(provider IN ('cloud','evolution')),
 source_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS automation_message_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_key text NOT NULL REFERENCES automation_inbound_receipts(event_key),
 automation_id uuid REFERENCES automations(id) ON DELETE SET NULL, automation_name text NOT NULL,
 phone text NOT NULL, provider text NOT NULL CHECK(provider IN ('cloud','evolution')), source_id text NOT NULL,
 body text NOT NULL, step integer NOT NULL CHECK(step>=0), handoff boolean NOT NULL DEFAULT false,
 legacy_message_id uuid REFERENCES whatsapp_messages(id) ON DELETE SET NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','sent','failed','skipped','uncertain')),
 run_at timestamptz NOT NULL, started_at timestamptz, finished_at timestamptz, details text,
 created_at timestamptz NOT NULL DEFAULT NOW(), UNIQUE(event_key,step)
);
CREATE INDEX IF NOT EXISTS automation_jobs_due ON automation_message_jobs(run_at) WHERE status='queued';
CREATE INDEX IF NOT EXISTS automation_jobs_phone ON automation_message_jobs(phone,provider,source_id,created_at DESC);
ALTER TABLE automation_inbound_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_message_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON automation_inbound_receipts,automation_message_jobs FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON automation_inbound_receipts,automation_message_jobs FROM %I',r);
  END IF;
 END LOOP;
END $$;
COMMIT;
