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

CREATE TRIGGER trg_cloud_conv_updated_at
  BEFORE UPDATE ON cloud_conversations
  FOR EACH ROW EXECUTE FUNCTION set_cloud_updated_at();
