-- Explicit campaign attribution. Historical campaigns remain unassigned until
-- an administrator selects an agent; names/contact panels are not evidence.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS agent_key text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS agent_key text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS line_id uuid REFERENCES whatsapp_lines(id) ON DELETE SET NULL;
ALTER TABLE conversation_notes ADD COLUMN IF NOT EXISTS agent_key text;
ALTER TABLE marketing_calendar ADD COLUMN IF NOT EXISTS agent_key text;

CREATE INDEX IF NOT EXISTS cr_agent_message_lookup_idx ON campaign_recipients(campaign_id, (regexp_replace(phone_number,'[^0-9]','','g')), sent_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS campaigns_agent_created_idx ON campaigns(agent_key, created_at DESC);
CREATE INDEX IF NOT EXISTS conversation_notes_agent_phone_idx ON conversation_notes(agent_key, phone, created_at DESC);
CREATE INDEX IF NOT EXISTS marketing_calendar_agent_date_idx ON marketing_calendar(agent_key, date);
CREATE INDEX IF NOT EXISTS wm_agent_line_phone_idx ON whatsapp_messages(line_id, (regexp_replace(phone_number,'[^0-9]','','g')), created_at DESC);

-- Keep workflow/bot state independent from an agent's CRM status.
CREATE TABLE IF NOT EXISTS agent_conversation_state (
  agent_key text NOT NULL,
  phone_number text NOT NULL,
  current_flow text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(agent_key, phone_number)
);
ALTER TABLE agent_conversation_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agent_conversation_state FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON agent_conversation_state FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON agent_conversation_state FROM authenticated;
  END IF;
END $$;

-- Preserve existing calendar grants while separating future module selection.
UPDATE users SET sectors=sectors || '["calendar"]'::jsonb
WHERE sectors ? 'tasks' AND NOT sectors ? 'calendar';
