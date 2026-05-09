-- Consentimiento y opt-outs para Cloud API
-- Obligatorio para cumplimiento de políticas de Meta y RGPD/PDPA

CREATE TABLE IF NOT EXISTS cloud_consent_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_phone   TEXT NOT NULL,
  phone_number_id TEXT NOT NULL,

  event           TEXT NOT NULL,
  -- opt_in | opt_out | stop_keyword | reinstated | exported | deleted

  channel         TEXT NOT NULL DEFAULT 'whatsapp', -- whatsapp | web | sms | manual
  source          TEXT,            -- inbound_message | landing_page | agent_action | import
  message_wamid   TEXT,            -- WAMID del mensaje de opt-out si fue por mensaje entrante
  agent_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  ip_address      INET,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consent_phone   ON cloud_consent_log(contact_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consent_event   ON cloud_consent_log(event, created_at DESC);

-- Vista materializada de estado actual de opt-out (más eficiente que subquery)
CREATE TABLE IF NOT EXISTS cloud_opt_outs (
  contact_phone   TEXT NOT NULL,
  phone_number_id TEXT NOT NULL,
  opted_out       BOOLEAN NOT NULL DEFAULT false,
  opted_out_at    TIMESTAMPTZ,
  reason          TEXT,             -- stop_keyword | manual | policy_violation
  PRIMARY KEY (contact_phone, phone_number_id)
);

CREATE INDEX IF NOT EXISTS idx_opt_outs_opted ON cloud_opt_outs(phone_number_id) WHERE opted_out = true;

-- Keywords de opt-out en distintos idiomas
CREATE TABLE IF NOT EXISTS cloud_stop_keywords (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword     TEXT NOT NULL UNIQUE,
  language    TEXT NOT NULL DEFAULT 'es',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO cloud_stop_keywords (keyword, language) VALUES
  ('STOP',         'en'),
  ('BAJA',         'es'),
  ('DETENER',      'es'),
  ('CANCELAR',     'es'),
  ('NO QUIERO',    'es'),
  ('UNSUBSCRIBE',  'en'),
  ('OPT OUT',      'en'),
  ('OPTOUT',       'en'),
  ('SALIR',        'es'),
  ('QUITAR',       'es')
ON CONFLICT (keyword) DO NOTHING;
