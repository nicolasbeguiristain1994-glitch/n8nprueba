-- Números registrados en WhatsApp Cloud API con Coexistence
-- Cada registro representa un número onboarded vía Embedded Signup
-- con featureType = 'whatsapp_business_app_onboarding'

CREATE TABLE IF NOT EXISTS cloud_numbers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificadores de Meta
  waba_id             TEXT NOT NULL,
  phone_number_id     TEXT NOT NULL UNIQUE,
  display_phone       TEXT NOT NULL,            -- E.164: +5491112345678
  verified_name       TEXT,                     -- Nombre verificado por Meta

  -- Tokens (cifrados en producción via columna bytea + pgcrypto, aquí text por simplicidad)
  access_token        TEXT NOT NULL,            -- System User token long-lived
  token_expires_at    TIMESTAMPTZ,              -- NULL = nunca vence (system user)

  -- Estado del número
  status              TEXT NOT NULL DEFAULT 'pending',
  -- pending | code_sent | verified | active | suspended | banned

  -- Coexistence específico
  coexistence_enabled BOOLEAN NOT NULL DEFAULT true,
  -- sync_state: estado de la sincronización inicial obligatoria
  contacts_synced     BOOLEAN NOT NULL DEFAULT false,
  history_synced      BOOLEAN NOT NULL DEFAULT false,
  history_sync_days   INT DEFAULT 180,          -- días de historial a sincronizar

  -- Calidad del número (tier de límites de Meta)
  quality_rating      TEXT DEFAULT 'GREEN',     -- GREEN | YELLOW | RED
  messaging_limit_tier TEXT DEFAULT 'TIER_1K', -- TIER_1K | TIER_10K | TIER_100K | UNLIMITED

  -- Metadatos
  whatsapp_line_id    UUID REFERENCES whatsapp_lines(id) ON DELETE SET NULL,
  onboarded_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  onboarded_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cloud_numbers_waba    ON cloud_numbers(waba_id);
CREATE INDEX IF NOT EXISTS idx_cloud_numbers_status  ON cloud_numbers(status);
CREATE INDEX IF NOT EXISTS idx_cloud_numbers_line    ON cloud_numbers(whatsapp_line_id);

-- Estado del procesamiento de webhooks y sync para cada número
CREATE TABLE IF NOT EXISTS cloud_sync_state (
  phone_number_id     TEXT PRIMARY KEY REFERENCES cloud_numbers(phone_number_id) ON DELETE CASCADE,
  last_webhook_at     TIMESTAMPTZ,
  contacts_sync_job   TEXT,                     -- BullMQ job ID
  history_sync_job    TEXT,                     -- BullMQ job ID
  history_cursor      TEXT,                     -- cursor de paginación para sync de historial
  sync_error          TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Webhook subscription tracking
CREATE TABLE IF NOT EXISTS cloud_webhook_subscriptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number_id     TEXT NOT NULL REFERENCES cloud_numbers(phone_number_id) ON DELETE CASCADE,
  subscribed_fields   TEXT[] NOT NULL DEFAULT ARRAY['messages', 'history', 'smb_app_state_sync', 'smb_message_echoes'],
  verified            BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger: updated_at automático
CREATE OR REPLACE FUNCTION set_cloud_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_cloud_numbers_updated_at
  BEFORE UPDATE ON cloud_numbers
  FOR EACH ROW EXECUTE FUNCTION set_cloud_updated_at();
