BEGIN;

-- ── Historial de corridas de recompute ────────────────────────────────────────
--
-- Tabla append-only: cada fila es el registro de una ejecución de recomputeAll.
-- Nunca se modifican filas anteriores — solo INSERTs.
-- El link con system_jobs es via run_id (= lock_token de esa corrida).
--
-- Casos de uso principales:
--   1. Debugging: ver si el recompute corrió y cuándo.
--   2. Alertas: detectar corridas fallidas o revocadas consecutivas.
--   3. Auditoría: correlacionar run_id con datos en contact_priority_scores.
--
-- Consultas frecuentes:
--   -- Últimas 10 corridas:
--   SELECT * FROM recompute_runs ORDER BY started_at DESC LIMIT 10;
--   -- Corridas fallidas:
--   SELECT * FROM recompute_runs WHERE status != 'success' ORDER BY started_at DESC;
--   -- Detalles de un run específico:
--   SELECT * FROM recompute_runs WHERE run_id = '<uuid>';

CREATE TABLE IF NOT EXISTS recompute_runs (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID        NOT NULL,
  started_at         TIMESTAMPTZ NOT NULL,
  finished_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             TEXT        NOT NULL,
  contacts_processed INT         NOT NULL DEFAULT 0,
  contacts_updated   INT         NOT NULL DEFAULT 0,   -- contactos elegibles (serán contactados)
  duration_ms        INT         NOT NULL DEFAULT 0,
  error_message      TEXT,
  instance_id        TEXT,                              -- hostname/pid para correlacionar con logs
  CONSTRAINT recompute_runs_status_check
    CHECK (status IN ('success', 'failed', 'revoked'))
);

COMMENT ON TABLE recompute_runs IS
  'Historial append-only de corridas de recomputeAll. Una fila por ejecución.';
COMMENT ON COLUMN recompute_runs.run_id IS
  'Mismo UUID que lock_token de esa corrida. Linkea con contact_priority_scores.run_id.';
COMMENT ON COLUMN recompute_runs.contacts_updated IS
  'Contactos elegibles para reactivación en esta corrida (subset de contacts_processed).';
COMMENT ON COLUMN recompute_runs.status IS
  'success = corrida completa; failed = error inesperado; revoked = lock revocado por otra instancia.';

-- Índice para queries operativas (recientes primero)
CREATE INDEX IF NOT EXISTS idx_recompute_runs_started_at
  ON recompute_runs (started_at DESC);

-- Índice para correlacionar con contact_priority_scores por run_id
CREATE INDEX IF NOT EXISTS idx_recompute_runs_run_id
  ON recompute_runs (run_id);

COMMIT;
