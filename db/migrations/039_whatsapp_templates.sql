CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT        NOT NULL UNIQUE,
  category              TEXT        NOT NULL CHECK (category IN ('UTILITY','MARKETING','AUTHENTICATION')),
  language              TEXT        NOT NULL DEFAULT 'es',
  status                TEXT        NOT NULL DEFAULT 'BORRADOR'
                                    CHECK (status IN ('BORRADOR','EN_REVISION','APROBADA','RECHAZADA','DESHABILITADA')),
  components            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  whatsapp_template_id  TEXT,
  rejection_reason      TEXT,
  usage_count           INTEGER     NOT NULL DEFAULT 0,
  last_used_at          TIMESTAMPTZ,
  created_by            UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Columnas agregadas en revisión posterior — idempotentes si la tabla ya existía
ALTER TABLE whatsapp_templates
  ADD COLUMN IF NOT EXISTS category             TEXT NOT NULL DEFAULT 'MARKETING',
  ADD COLUMN IF NOT EXISTS language             TEXT NOT NULL DEFAULT 'es',
  ADD COLUMN IF NOT EXISTS status               TEXT NOT NULL DEFAULT 'BORRADOR',
  ADD COLUMN IF NOT EXISTS components           JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS whatsapp_template_id TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason     TEXT,
  ADD COLUMN IF NOT EXISTS usage_count          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_status   ON whatsapp_templates(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_category ON whatsapp_templates(category);
