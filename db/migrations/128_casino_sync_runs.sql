-- 128_casino_sync_runs.sql
--
-- Fase 4 del plan de sincronización multi-plataforma (D4, "Aceptación" de la
-- fase 4 y H del pipeline: "un fallo de sync nunca debe terminar en exit 0
-- ni quedar invisible").
--
-- Por qué: hasta esta migración un sync caído solo se veía en logs de
-- proceso (stdout/stderr de Railway/n8n), nunca en la base. casino_sync_runs
-- da un registro persistente, por (platform, agente), de cada intento —
-- running al arrancar, ok/failed/skipped al terminar — para que el dashboard
-- (GET /api/dashboard/casino/sync-status, fase 4) y el pipeline diario puedan
-- mostrar el último estado real sin adivinar a partir de MAX(fecha_hora_utc).
--
-- Un registro se crea ANTES de intentar construir el conector/autenticar —
-- si eso falla (env var faltante, login roto), igual queda un run 'failed'
-- visible, no un silencio (ver scripts/lib/casino-sync-orchestrator.js).
-- `agente` es NULL solo para esos fallos a nivel de plataforma completa
-- (nunca se llegó a saber con qué agente se iba a sincronizar).
--
-- `error` guarda el mensaje ya sanitizado que produce cada conector — nunca
-- se persiste una URL, token, cookie o password cruda; el propio código que
-- inserta la fila es responsable de eso (ver BaseCasinoConnector/conectores,
-- que ya sanitizan sus propios mensajes de error desde fase 2/3).
--
-- range_desde/range_hasta guardan el rango que efectivamente se intentó
-- sincronizar (útil para depurar sin tener que cruzar contra logs).
--
-- Dueño de la base: correr esta migración ANTES de desplegar el orquestador
-- de fase 4 — sin la tabla, el orquestador no puede registrar corridas y
-- falla con un error explícito (ver casino-sync-orchestrator.js: "falla
-- stderr exit1" cuando la tabla no existe, nunca en silencio).

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE IF NOT EXISTS casino_sync_runs (
  id            bigserial PRIMARY KEY,
  platform      text        NOT NULL,
  agente        text,                          -- NULL sólo para fallos de plataforma completa (constructor/auth)
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text        NOT NULL DEFAULT 'running',
  tx_inserted   integer,
  range_desde   text,                          -- rango efectivamente solicitado (fecha o timestamp ISO)
  range_hasta   text,
  error         text,                          -- ya sanitizado por el llamador — nunca crudo de una excepción HTTP
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT casino_sync_runs_status_check
    CHECK (status IN ('running', 'ok', 'failed', 'skipped')),
  CONSTRAINT casino_sync_runs_finished_after_started
    CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_casino_sync_runs_platform_agente_started
  ON casino_sync_runs (platform, agente, started_at DESC);

-- El dashboard sólo necesita "el último run por (platform, agente)" — este
-- índice cubre exactamente ese acceso sin escanear toda la tabla.
CREATE INDEX IF NOT EXISTS idx_casino_sync_runs_status
  ON casino_sync_runs (platform, status, started_at DESC);

ALTER TABLE casino_sync_runs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE casino_sync_runs IS
  'Fase 4 (D4): historial de corridas de sync por (platform, agente). running al '
  'iniciar, ok/failed/skipped al terminar (finally). Nunca contiene tokens, '
  'cookies, passwords ni URLs con querystring de auth — solo mensajes de error '
  'ya sanitizados por el conector/orquestador que los produjo.';

COMMIT;
