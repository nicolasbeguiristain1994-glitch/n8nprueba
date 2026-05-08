-- 063_warmup_effectiveness_snapshots.sql
-- Snapshots periódicos de métricas de efectividad del módulo de calentamiento.
-- Alimentados por GET /api/warmup/effectiveness (guarda snapshot si hay datos nuevos).
-- Permite comparar semana a semana / mes a mes la evolución de la plataforma.

CREATE TABLE IF NOT EXISTS warmup_effectiveness_snapshots (
  id               UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  period           TEXT         NOT NULL CHECK (period IN ('weekly', 'monthly')),
  period_start     DATE         NOT NULL,
  period_end       DATE         NOT NULL,
  total_lines      INTEGER      NOT NULL DEFAULT 0,
  active_lines     INTEGER      NOT NULL DEFAULT 0,
  completed_lines  INTEGER      NOT NULL DEFAULT 0,
  banned_lines     INTEGER      NOT NULL DEFAULT 0,
  success_rate     NUMERIC(5,2) NOT NULL DEFAULT 0,
  completion_ratio NUMERIC(5,2) NOT NULL DEFAULT 0,
  ban_rate         NUMERIC(5,2) NOT NULL DEFAULT 0,
  -- JSONB con byStrategy: [{ preset, totalLines, completedLines, ... }]
  by_strategy      JSONB        NOT NULL DEFAULT '[]',
  recorded_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (period, period_start)
);

-- Consultas de historial por período
CREATE INDEX IF NOT EXISTS idx_wes_period
  ON warmup_effectiveness_snapshots (period, period_start DESC);

COMMENT ON TABLE  warmup_effectiveness_snapshots IS 'Snapshots periódicos de efectividad del calentamiento';
COMMENT ON COLUMN warmup_effectiveness_snapshots.success_rate     IS 'completedLines / (completedLines + bannedLines) × 100';
COMMENT ON COLUMN warmup_effectiveness_snapshots.completion_ratio IS 'completedLines / totalLines × 100';
COMMENT ON COLUMN warmup_effectiveness_snapshots.by_strategy      IS 'Métricas desglosadas por preset (conservadora, normal, agresiva)';
