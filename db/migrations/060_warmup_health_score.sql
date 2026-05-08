-- 060_warmup_health_score.sql
-- Agrega score de salud calculado y su timestamp al registro de warmup.
-- El score es actualizado por POST /api/warmup/schedule y leído en GET /api/warmup.

ALTER TABLE warmup_numbers
  ADD COLUMN IF NOT EXISTS health_score       INTEGER DEFAULT 50
    CHECK (health_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS health_updated_at  TIMESTAMP WITH TIME ZONE;

-- Índice parcial para filtrar líneas activas por salud (ej: health < 40)
CREATE INDEX IF NOT EXISTS idx_warmup_numbers_health_score
  ON warmup_numbers(health_score)
  WHERE warmup_status = 'active';
