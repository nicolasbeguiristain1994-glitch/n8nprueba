-- 062_warmup_alerts.sql
-- Alertas predictivas generadas por el orquestador de calentamiento.
-- Alimentadas por POST /api/warmup/orchestrator/run (diariamente vía n8n).
-- También consultables por /api/warmup/alerts y resolvibles individualmente.

CREATE TABLE IF NOT EXISTS warmup_alerts (
  id               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  warmup_number_id UUID        NOT NULL REFERENCES warmup_numbers(id) ON DELETE CASCADE,
  severity         TEXT        NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  type             TEXT        NOT NULL CHECK (type IN ('ban_risk', 'inactivity', 'health_drop', 'high_failure_rate')),
  message          TEXT        NOT NULL,
  -- Datos contextuales: score actual, días de inactividad, tasa de fallos, etc.
  data             JSONB       NOT NULL DEFAULT '{}',
  triggered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = activa; NOT NULL = resuelta
  resolved_at      TIMESTAMPTZ,
  resolved_by      TEXT        -- email del usuario que resolvió, o 'system'
);

-- Búsqueda de alertas activas por línea (el uso más frecuente)
CREATE INDEX IF NOT EXISTS idx_wa_line_active
  ON warmup_alerts (warmup_number_id, triggered_at DESC)
  WHERE resolved_at IS NULL;

-- Filtrado global por severidad (alertas activas)
CREATE INDEX IF NOT EXISTS idx_wa_severity_active
  ON warmup_alerts (severity, triggered_at DESC)
  WHERE resolved_at IS NULL;

-- Limpieza de registros viejos / queries por fecha
CREATE INDEX IF NOT EXISTS idx_wa_triggered_at
  ON warmup_alerts (triggered_at DESC);

-- Prevención de duplicados: una sola alerta activa por (línea, tipo)
-- Se implementa en la capa de aplicación (INSERT solo si no existe activa del mismo tipo).

COMMENT ON TABLE  warmup_alerts IS 'Alertas predictivas del sistema de calentamiento';
COMMENT ON COLUMN warmup_alerts.type     IS 'ban_risk | inactivity | health_drop | high_failure_rate';
COMMENT ON COLUMN warmup_alerts.severity IS 'low | medium | high | critical';
COMMENT ON COLUMN warmup_alerts.data     IS 'Contexto: score, días inactivo, tasa de fallos, etc.';
COMMENT ON COLUMN warmup_alerts.resolved_at IS 'NULL = alerta activa';
