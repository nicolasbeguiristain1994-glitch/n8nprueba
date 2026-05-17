-- Migration 078: Base de Difusión — tabla prospects + batches de importación
--
-- Introduce una entidad separada para contactos fríos / prospectos externos.
-- Separados de `contacts` intencionalmente: tienen un ciclo de vida distinto y
-- no tienen datos de casino. El objetivo principal es difundirlos en campañas.
--
-- Cambios en campaign_recipients:
--   - contact_id pasa a nullable (era NOT NULL)
--   - Se agrega prospect_id (nullable, FK a prospects)
--   - CHECK garantiza que exactamente uno de los dos esté seteado
--   - UNIQUE (campaign_id, contact_id) pasa a dos partial indexes
--
-- El distribuidor de campañas (campaign-distributor.ts) ya maneja el
-- LEFT JOIN a contacts para resolver first_name. Con esta migración
-- también hace LEFT JOIN a prospects como fallback.

BEGIN;

-- ── 0. Helper: updated_at trigger function (idempotente) ──────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 1. prospect_import_batches ─────────────────────────────────────────────────

CREATE TABLE prospect_import_batches (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  filename                   TEXT,
  total_rows                 INT         NOT NULL DEFAULT 0,
  imported                   INT         NOT NULL DEFAULT 0,
  skipped_duplicates         INT         NOT NULL DEFAULT 0,    -- ya existían en prospects
  skipped_invalid            INT         NOT NULL DEFAULT 0,    -- teléfono inválido
  warned_existing_contacts   INT         NOT NULL DEFAULT 0,    -- teléfono ya en contacts
  created_by                 UUID        REFERENCES users(id) ON DELETE SET NULL,
  notes                      TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. prospects ───────────────────────────────────────────────────────────────

CREATE TABLE prospects (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number    TEXT        NOT NULL UNIQUE,  -- E.164, dedup absoluto
  first_name      TEXT,
  last_name       TEXT,
  email           TEXT,
  tags            TEXT[]      NOT NULL DEFAULT '{}',
  source          TEXT        NOT NULL DEFAULT 'csv_import',  -- csv_import | manual
  import_batch_id UUID        REFERENCES prospect_import_batches(id) ON DELETE SET NULL,
  status          TEXT        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'unsubscribed')),
  opt_in          BOOLEAN     NOT NULL DEFAULT true,
  consent_source  TEXT,       -- csv_import | manual | formulario_web | etc.
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_prospects_phone      ON prospects(phone_number);
CREATE INDEX idx_prospects_status     ON prospects(status);
CREATE INDEX idx_prospects_batch      ON prospects(import_batch_id);
CREATE INDEX idx_prospects_created_at ON prospects(created_at DESC);

CREATE TRIGGER trg_prospects_updated_at
  BEFORE UPDATE ON prospects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── 3. campaign_recipients: agregar soporte para prospect_id ──────────────────

-- contact_id pasa a nullable (antes era NOT NULL)
ALTER TABLE campaign_recipients
  ALTER COLUMN contact_id DROP NOT NULL;

-- Agrega columna prospect_id
ALTER TABLE campaign_recipients
  ADD COLUMN prospect_id UUID REFERENCES prospects(id) ON DELETE CASCADE;

-- Exactamente uno de los dos debe estar seteado
ALTER TABLE campaign_recipients
  ADD CONSTRAINT campaign_recipients_source_check
  CHECK (
    (contact_id IS NOT NULL AND prospect_id IS NULL) OR
    (contact_id IS NULL     AND prospect_id IS NOT NULL)
  );

-- La constraint UNIQUE original (campaign_id, contact_id) no cubre el caso
-- de prospect_id. La reemplazamos por dos partial unique indexes.
ALTER TABLE campaign_recipients
  DROP CONSTRAINT IF EXISTS campaign_recipients_campaign_id_contact_id_key;

CREATE UNIQUE INDEX idx_cr_unique_contact
  ON campaign_recipients (campaign_id, contact_id)
  WHERE contact_id IS NOT NULL;

CREATE UNIQUE INDEX idx_cr_unique_prospect
  ON campaign_recipients (campaign_id, prospect_id)
  WHERE prospect_id IS NOT NULL;

COMMIT;
