-- Restore missing Cloud API schema using additive, repeatable changes.
-- No token rotation, data deletion or live number registration.
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

DROP TRIGGER IF EXISTS trg_cloud_numbers_updated_at ON cloud_numbers;
CREATE TRIGGER trg_cloud_numbers_updated_at
  BEFORE UPDATE ON cloud_numbers
  FOR EACH ROW EXECUTE FUNCTION set_cloud_updated_at();


-- Conversaciones y mensajes via Cloud API
-- Separados de la tabla legacy whatsapp_messages (Evolution/Baileys)

CREATE TABLE IF NOT EXISTS cloud_conversations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number_id     TEXT NOT NULL REFERENCES cloud_numbers(phone_number_id) ON DELETE CASCADE,
  contact_phone       TEXT NOT NULL,            -- E.164 del contacto

  -- Ventana de servicio de 24h (Customer Service Window)
  window_opens_at     TIMESTAMPTZ,
  window_expires_at   TIMESTAMPTZ,
  window_type         TEXT,                     -- customer_initiated | business_initiated

  -- Estado de la conversación
  status              TEXT NOT NULL DEFAULT 'open', -- open | closed | archived
  unread_count        INT NOT NULL DEFAULT 0,
  last_message_at     TIMESTAMPTZ,
  last_message_preview TEXT,

  -- Coexistence: mensajes que llegan desde la WA Business App
  has_smb_echoes      BOOLEAN NOT NULL DEFAULT false,

  -- Relación con entidades del dominio
  contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(phone_number_id, contact_phone)
);

CREATE INDEX IF NOT EXISTS idx_cloud_conv_number   ON cloud_conversations(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_cloud_conv_contact  ON cloud_conversations(contact_phone);
CREATE INDEX IF NOT EXISTS idx_cloud_conv_window   ON cloud_conversations(window_expires_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_cloud_conv_contact_id ON cloud_conversations(contact_id);

CREATE TABLE IF NOT EXISTS cloud_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID NOT NULL REFERENCES cloud_conversations(id) ON DELETE CASCADE,
  phone_number_id     TEXT NOT NULL,

  -- Identificadores de Meta
  wamid               TEXT UNIQUE,             -- wa.me message ID (msgid retornado por Cloud API)
  meta_message_id     TEXT,                     -- ID en el sistema de Meta

  -- Dirección
  direction           TEXT NOT NULL,            -- outbound | inbound | echo
  -- echo = mensaje enviado desde WA Business App (smb_message_echoes webhook)

  -- Contenido
  message_type        TEXT NOT NULL,
  -- text | template | image | video | audio | document | sticker | reaction
  -- location | contacts | interactive | order | button

  content             JSONB NOT NULL,           -- payload completo del mensaje
  template_name       TEXT,                     -- si es tipo template
  template_language   TEXT,

  -- Estado de entrega (outbound)
  status              TEXT NOT NULL DEFAULT 'queued',
  -- queued | sent | delivered | read | failed | deleted

  -- Errores de Meta
  error_code          INT,
  error_title         TEXT,
  error_details       TEXT,
  error_fbtrace_id    TEXT,

  -- Pricing (Meta cobra por conversación, no por mensaje)
  pricing_model       TEXT,                     -- CBP (conversation-based pricing)
  pricing_category    TEXT,                     -- marketing | utility | service | authentication
  billable            BOOLEAN,

  -- Trazabilidad
  queued_at           TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  read_at             TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,

  -- Para mensajes inbound históricos (sync de historial)
  is_historical       BOOLEAN NOT NULL DEFAULT false,
  original_timestamp  TIMESTAMPTZ,

  -- Auditoría
  sent_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  campaign_id         UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_direction CHECK (direction IN ('outbound', 'inbound', 'echo')),
  CONSTRAINT chk_status CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_msg_conv        ON cloud_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_cloud_msg_wamid       ON cloud_messages(wamid) WHERE wamid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cloud_msg_status      ON cloud_messages(status, phone_number_id);
CREATE INDEX IF NOT EXISTS idx_cloud_msg_campaign    ON cloud_messages(campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cloud_msg_created     ON cloud_messages(created_at DESC);

DROP TRIGGER IF EXISTS trg_cloud_conv_updated_at ON cloud_conversations;
CREATE TRIGGER trg_cloud_conv_updated_at
  BEFORE UPDATE ON cloud_conversations
  FOR EACH ROW EXECUTE FUNCTION set_cloud_updated_at();


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


-- Encriptación en reposo de access_tokens de Cloud API
--
-- ESTRATEGIA DE KEY MANAGEMENT:
--   La clave de cifrado NUNCA se almacena en la base de datos.
--   Vive en Doppler como TOKEN_ENCRYPTION_KEY (AES-256, 32 bytes en hex).
--   La aplicación la pasa como parámetro a pgp_sym_encrypt/pgp_sym_decrypt.
--   Rotación de clave: re-encriptar con nueva clave usando decrypt(old)+encrypt(new)
--   en un proceso de mantenimiento, NO en una migración SQL.
--
-- PROCESO DE MIGRACIÓN:
--   1. Esta SQL agrega la columna cifrada (nullable durante transición).
--   2. La aplicación hace lazy migration: lee plaintext si enc = NULL,
--      re-encripta en el mismo UPDATE.
--   3. Después de verificar 100% enc != NULL: DROP COLUMN access_token.
--   4. NOT NULL en access_token_enc se activa con la migración 071.
--
-- ROLLBACK:
--   Si es necesario revertir, access_token sigue existiendo hasta la migración 071.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Columna cifrada: bytea porque pgp_sym_encrypt retorna bytea
ALTER TABLE cloud_numbers
  ADD COLUMN IF NOT EXISTS access_token_enc BYTEA;

-- La columna original access_token se mantiene durante la transición para rollback.
-- Se marcará como deprecated en los comentarios de código.
COMMENT ON COLUMN cloud_numbers.access_token IS
  'DEPRECATED: plaintext token — solo para rollback. Usar access_token_enc.';

COMMENT ON COLUMN cloud_numbers.access_token_enc IS
  'Token cifrado con AES-256 via pgp_sym_encrypt. Clave en Doppler: TOKEN_ENCRYPTION_KEY';

-- Índice de auditoría: qué números ya fueron migrados a cifrado
CREATE INDEX IF NOT EXISTS idx_cloud_numbers_enc_migrated
  ON cloud_numbers(id)
  WHERE access_token_enc IS NOT NULL;


-- Agrega campos para rastrear el inbox de Chatwoot asociado a cada número Cloud API.

ALTER TABLE cloud_numbers
  ADD COLUMN IF NOT EXISTS chatwoot_inbox_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS chatwoot_inbox_name TEXT,
  ADD COLUMN IF NOT EXISTS chatwoot_created_at TIMESTAMPTZ;

COMMENT ON COLUMN cloud_numbers.chatwoot_inbox_id   IS 'ID del inbox en Chatwoot (string devuelto por la API de Chatwoot)';
COMMENT ON COLUMN cloud_numbers.chatwoot_inbox_name IS 'Nombre del inbox en Chatwoot al momento de la creación';
COMMENT ON COLUMN cloud_numbers.chatwoot_created_at IS 'Timestamp en que se creó el inbox en Chatwoot';


ALTER TABLE cloud_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_opt_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_stop_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_consent_log ENABLE ROW LEVEL SECURITY;