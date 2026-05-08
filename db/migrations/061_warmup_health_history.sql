-- 061_warmup_health_history.sql
-- Historial de scores de salud por línea de calentamiento.
-- Alimentado por POST /api/warmup/orchestrator/run (diariamente a las 00:05 vía n8n).
-- Permite visualizar la evolución de salud y detectar tendencias a lo largo del tiempo.

CREATE TABLE IF NOT EXISTS warmup_health_history (
  id                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  warmup_number_id  UUID        NOT NULL REFERENCES warmup_numbers(id) ON DELETE CASCADE,
  score             INTEGER     NOT NULL CHECK (score BETWEEN 0 AND 100),
  -- Desglose de componentes del score (base, progressScore, trendScore, etc.)
  components        JSONB       NOT NULL DEFAULT '{}',
  -- Cuota diaria asignada por DailyQuotaCalculatorService en el momento del registro
  daily_quota       INTEGER     NOT NULL DEFAULT 0 CHECK (daily_quota >= 0),
  -- Mensajes ya enviados en ese momento del día
  messages_sent     INTEGER     NOT NULL DEFAULT 0 CHECK (messages_sent >= 0),
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice principal: consultas por línea ordenadas por fecha (historial cronológico)
CREATE INDEX IF NOT EXISTS idx_whh_line_date
  ON warmup_health_history (warmup_number_id, recorded_at DESC);

-- Índice para queries globales por fecha (ej: limpiar registros viejos)
CREATE INDEX IF NOT EXISTS idx_whh_recorded_at
  ON warmup_health_history (recorded_at DESC);

-- Comentarios de columna
COMMENT ON TABLE  warmup_health_history IS 'Historial diario de scores de salud por línea de calentamiento';
COMMENT ON COLUMN warmup_health_history.components   IS 'JSONB con los 6 componentes del score: base, progressScore, trendScore, activityScore, inactivityPenalty, failurePenalty';
COMMENT ON COLUMN warmup_health_history.daily_quota  IS 'Cuota diaria calculada por DailyQuotaCalculatorService (base × factorSalud × factorEstrategia)';
COMMENT ON COLUMN warmup_health_history.messages_sent IS 'Mensajes enviados en el momento de registrar el snapshot';
