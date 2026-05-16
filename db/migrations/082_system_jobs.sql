BEGIN;

-- ── Tabla de control para jobs de larga duración ─────────────────────────────
--
-- Provee locking distribuido sin Redis para operaciones de batch (recompute,
-- importaciones pesadas, etc.).
--
-- Mecanismo: UPDATE atómico con condición en la misma fila.
-- Solo una instancia puede poner is_running = true porque el WHERE garantiza
-- exclusión mutua a nivel de PostgreSQL.
--
-- Si una instancia muere sin liberar el lock, expires_at actúa de TTL:
-- otra instancia puede adquirirlo cuando expires_at < NOW().

CREATE TABLE IF NOT EXISTS system_jobs (
  job_name        TEXT        PRIMARY KEY,
  is_running      BOOLEAN     NOT NULL DEFAULT false,
  started_at      TIMESTAMPTZ,
  started_by      TEXT,            -- Hostname/instance ID para debugging
  expires_at      TIMESTAMPTZ,     -- TTL del lock (protege contra instancias muertas)
  last_success_at TIMESTAMPTZ,
  last_result     JSONB            -- Resumen del último run completado
);

INSERT INTO system_jobs (job_name) VALUES ('prioritization_recompute')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE system_jobs IS
  'Locking distribuido para jobs de batch. Alternativa liviana a BullMQ para jobs simples.';
COMMENT ON COLUMN system_jobs.expires_at IS
  'TTL del lock. Si expires_at < NOW() otro proceso puede adquirirlo (protege contra crashes).';

COMMIT;
