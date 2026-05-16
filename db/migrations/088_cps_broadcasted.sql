-- 088 — contact_priority_scores: columnas de difusión manual
-- is_broadcasted: true cuando un operador marcó el contacto como ya difundido
-- broadcasted_at: timestamp del momento en que se marcó
-- broadcasted_by: usuario que realizó la acción (para auditoría)

ALTER TABLE contact_priority_scores
  ADD COLUMN IF NOT EXISTS is_broadcasted  BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS broadcasted_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS broadcasted_by  TEXT;

CREATE INDEX IF NOT EXISTS idx_cps_broadcasted
  ON contact_priority_scores (is_broadcasted)
  WHERE is_eligible = true;
