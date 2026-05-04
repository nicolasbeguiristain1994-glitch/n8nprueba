-- Migration 049: Pipeline Deals
-- Tabla principal de deals para el módulo Pipeline/Kanban

CREATE TABLE IF NOT EXISTS deals (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  amount        NUMERIC(12, 2),
  stage         TEXT NOT NULL DEFAULT 'calificado'
                  CHECK (stage IN ('calificado','propuesta','negociacion','cierre','ganado','perdido')),
  contact_id    UUID REFERENCES contacts(id) ON DELETE SET NULL,
  owner_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  close_date    DATE,
  notes         TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deals_stage    ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_owner_id ON deals(owner_id);
CREATE INDEX IF NOT EXISTS idx_deals_contact_id ON deals(contact_id);

-- trigger updated_at
CREATE OR REPLACE FUNCTION update_deals_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deals_updated_at ON deals;
CREATE TRIGGER trg_deals_updated_at
  BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION update_deals_updated_at();
