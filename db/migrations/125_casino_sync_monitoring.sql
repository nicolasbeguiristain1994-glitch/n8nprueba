-- ============================================================
-- Migration 125: Centro de Monitoreo — integridad y trazabilidad del sync de casino
-- ============================================================
--
-- ⚠️  ARCHIVO REVISABLE. No se aplica automáticamente (scripts/ops/run-migrations.mjs
--     termina en la 098). Antes de aplicarlo correr db/manual/125_preflight_readonly.sql
--     y seguir docs/runbooks/centro-monitoreo.md.
--
-- Qué resuelve:
--
--   1. casino_transactions.platform
--      Hasta ahora la tabla no sabía de qué casino venía cada fila. El índice único
--      global sobre id_rec hacía que un movimiento de Bet30 con el mismo ID que uno
--      de Zeus se tomara como "ya existente" y se perdiera en silencio.
--      Las filas históricas quedan con platform = NULL: NO se atribuyen acá. El
--      runner de sync se niega a escribir sobre un agente/rango que tenga filas
--      NULL (fail-closed) hasta que alguien las clasifique a mano
--      (db/manual/125_backfill_platform_inequivocos.sql, revisable).
--
--   2. Deduplicación por plataforma
--      - Con ID:  UNIQUE (platform, id_rec)
--      - Sin ID:  UNIQUE (platform, fecha, LOWER(username), tipo, monto, agente)
--      Las filas históricas (platform NULL) conservan exactamente la unicidad que
--      tenían, con índices parciales propios. Los scripts viejos que insertan sin
--      plataforma (seed-casino-transactions.js) dejan de encontrar un índice que
--      coincida con su ON CONFLICT y fallan en voz alta en vez de crear más filas
--      sin clasificar.
--
--   3. Registro de corridas (casino_sync_runs), resultado por agente y rango
--      (casino_sync_agent_ranges) y cursor por plataforma+agente
--      (casino_sync_cursors). Reemplazan el `MAX(fecha) + 1 day` global.
--
-- Seguridad: las tablas nuevas siguen la estrategia de 032/094/124 — RLS activado
-- sin policies (la anon key queda bloqueada; el backend usa conexión directa).
--
-- Bloqueos: CREATE UNIQUE INDEX toma un lock de escritura sobre casino_transactions
-- mientras construye el índice. Aplicar con el sync detenido.
-- ============================================================

BEGIN;

-- ── 1. Plataforma en casino_transactions ─────────────────────────────────────

ALTER TABLE casino_transactions
  ADD COLUMN IF NOT EXISTS platform text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname  = 'casino_transactions_platform_check'
      AND conrelid = 'casino_transactions'::regclass
  ) THEN
    ALTER TABLE casino_transactions
      ADD CONSTRAINT casino_transactions_platform_check
      CHECK (platform IS NULL OR platform IN ('zeus', 'bet30', 'ganamos', 'argenbet'));
  END IF;
END;
$$;

COMMENT ON COLUMN casino_transactions.platform IS
  'Casino de origen. NULL = fila histórica sin clasificar (anterior a la migración 125). '
  'El runner de sync falla (LEGACY_UNCLASSIFIED) si un agente/rango a sincronizar tiene filas NULL.';

-- ── 2. Deduplicación por plataforma ──────────────────────────────────────────
-- Primero se crean los índices nuevos y recién después se eliminan los viejos,
-- para que la unicidad no quede sin garantía en ningún momento de la transacción.

-- Filas nuevas con ID: el ID solo es único dentro de su plataforma.
CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_transactions_platform_id_rec
  ON casino_transactions (platform, id_rec)
  WHERE id_rec IS NOT NULL AND platform IS NOT NULL;

-- Filas históricas con ID: misma unicidad global que tenían hasta hoy.
CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_transactions_legacy_id_rec
  ON casino_transactions (id_rec)
  WHERE id_rec IS NOT NULL AND platform IS NULL;

-- Filas nuevas sin ID: clave por día. No distingue dos eventos iguales del mismo
-- día — el runner lo registra como cobertura limitada.
CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_transactions_platform_dedup
  ON casino_transactions (platform, fecha, (LOWER(username)), tipo, monto, agente)
  WHERE id_rec IS NULL AND platform IS NOT NULL;

-- Filas históricas sin ID: misma clave que el índice que reemplaza.
CREATE UNIQUE INDEX IF NOT EXISTS idx_casino_transactions_legacy_dedup
  ON casino_transactions (fecha, username, tipo, monto, agente)
  WHERE id_rec IS NULL AND platform IS NULL;

DROP INDEX IF EXISTS idx_casino_transactions_id_rec;
DROP INDEX IF EXISTS idx_casino_transactions_dedup;

-- Recompute de casino_players por LOWER(username) y consultas del monitoreo.
CREATE INDEX IF NOT EXISTS idx_casino_transactions_username_lower
  ON casino_transactions (LOWER(username));

CREATE INDEX IF NOT EXISTS idx_casino_transactions_platform_agente_fecha
  ON casino_transactions (platform, agente, fecha)
  WHERE platform IS NOT NULL;

-- Chequeo fail-closed del runner: LOWER(agente) = LOWER($1) AND fecha BETWEEN …
CREATE INDEX IF NOT EXISTS idx_casino_transactions_unclassified
  ON casino_transactions ((LOWER(agente)), fecha)
  WHERE platform IS NULL;

-- ── 3. Registro de corridas ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS casino_sync_runs (
  run_id                   uuid        PRIMARY KEY,
  platform                 text        NOT NULL,
  mode                     text        NOT NULL CHECK (mode IN ('auto', 'range')),
  triggered_by             text        NOT NULL DEFAULT 'cli'
                                       CHECK (triggered_by IN ('cli', 'api', 'pipeline')),
  requested_desde          date,
  requested_hasta          date,
  requested_agents         text[],
  status                   text        NOT NULL
                                       CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped')),
  started_at               timestamptz NOT NULL DEFAULT NOW(),
  heartbeat_at             timestamptz NOT NULL DEFAULT NOW(),
  finished_at              timestamptz,
  agents_total             int         NOT NULL DEFAULT 0,
  agents_ok                int         NOT NULL DEFAULT 0,
  agents_failed            int         NOT NULL DEFAULT 0,
  ranges_ok                int         NOT NULL DEFAULT 0,
  ranges_failed            int         NOT NULL DEFAULT 0,
  ranges_skipped           int         NOT NULL DEFAULT 0,
  tx_fetched               int         NOT NULL DEFAULT 0,
  tx_inserted              int         NOT NULL DEFAULT 0,
  tx_without_id            int         NOT NULL DEFAULT 0,
  players_recomputed       int         NOT NULL DEFAULT 0,
  error_code               text,
  error_message            text,        -- siempre sanitizado: sin URLs, tokens ni credenciales
  segmentation_status      text        NOT NULL DEFAULT 'not_requested'
                                       CHECK (segmentation_status IN
                                         ('not_requested', 'pending', 'running', 'success', 'failed', 'skipped')),
  segmentation_finished_at timestamptz,
  instance_id              text,        -- hostname:pid del runner; NULL = pre-registrada por la API, aún sin runner
  CONSTRAINT casino_sync_runs_finished_chk CHECK ((status = 'running') = (finished_at IS NULL))
);

COMMENT ON TABLE casino_sync_runs IS
  'Una fila por corrida de sync de casino. status=running con heartbeat_at viejo = corrida interrumpida.';

CREATE INDEX IF NOT EXISTS idx_casino_sync_runs_platform_started
  ON casino_sync_runs (platform, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_casino_sync_runs_started
  ON casino_sync_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_casino_sync_runs_running
  ON casino_sync_runs (platform, heartbeat_at)
  WHERE status = 'running';

-- ── 4. Resultado por agente y rango ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS casino_sync_agent_ranges (
  id                       bigserial   PRIMARY KEY,
  run_id                   uuid        NOT NULL REFERENCES casino_sync_runs (run_id) ON DELETE CASCADE,
  platform                 text        NOT NULL,
  agente                   text        NOT NULL,
  desde                    date,        -- NULL solo si el rango no pudo resolverse (CURSOR_MISSING)
  hasta                    date,
  status                   text        NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
  coverage                 text        CHECK (coverage IN ('complete', 'limited')),
  cursor_moved             boolean     NOT NULL DEFAULT false,
  fetch_started_at         timestamptz,
  finished_at              timestamptz NOT NULL DEFAULT NOW(),
  tx_fetched               int         NOT NULL DEFAULT 0,
  tx_normalized            int         NOT NULL DEFAULT 0,
  tx_inserted              int         NOT NULL DEFAULT 0,
  tx_updated               int         NOT NULL DEFAULT 0,
  tx_without_id            int         NOT NULL DEFAULT 0,
  tx_duplicate_ids         int         NOT NULL DEFAULT 0,
  tx_collapsed_without_id  int         NOT NULL DEFAULT 0,
  tx_invalid               int         NOT NULL DEFAULT 0,   -- filas que no se pudieron interpretar
  tx_excluded              int         NOT NULL DEFAULT 0,   -- exclusiones esperadas (entre agentes)
  players_recomputed       int         NOT NULL DEFAULT 0,
  error_code               text,
  error_message            text,
  CONSTRAINT casino_sync_agent_ranges_dates_chk
    CHECK (desde IS NULL OR hasta IS NULL OR desde <= hasta)
);

COMMENT ON TABLE casino_sync_agent_ranges IS
  'Resultado de cada (agente, rango) dentro de una corrida. Rango procesado ≠ completitud del proveedor: '
  'coverage=limited cuando hubo movimientos sin ID (dedup por día) o filas que no se pudieron interpretar.';

CREATE INDEX IF NOT EXISTS idx_casino_sync_agent_ranges_agent
  ON casino_sync_agent_ranges (platform, agente, finished_at DESC);

CREATE INDEX IF NOT EXISTS idx_casino_sync_agent_ranges_run
  ON casino_sync_agent_ranges (run_id);

-- ── 5. Cursor por plataforma y agente ────────────────────────────────────────
-- [covered_from, covered_through] es el último tramo CONTIGUO de días cerrados
-- (hora Argentina) sincronizados con éxito. Un rango disjunto no lo mueve.

CREATE TABLE IF NOT EXISTS casino_sync_cursors (
  platform        text        NOT NULL,
  agente          text        NOT NULL,
  covered_from    date        NOT NULL,
  covered_through date        NOT NULL,
  last_run_id     uuid        REFERENCES casino_sync_runs (run_id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (platform, agente),
  CONSTRAINT casino_sync_cursors_dates_chk CHECK (covered_from <= covered_through)
);

COMMENT ON TABLE casino_sync_cursors IS
  'Tramo contiguo de días cerrados (UTC-3) sincronizados con éxito por plataforma y agente. '
  'Lo mueve solo el runner, en la misma transacción que escribe los datos.';

-- ── 6. RLS (estrategia de 032/094/124: activado sin policies) ────────────────

ALTER TABLE casino_sync_runs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE casino_sync_agent_ranges ENABLE ROW LEVEL SECURITY;
ALTER TABLE casino_sync_cursors      ENABLE ROW LEVEL SECURITY;

-- Supabase otorga GRANT ALL a anon/authenticated por default privileges. Se
-- revoca además del RLS. Condicional: esos roles no existen en un Postgres local.
DO $$
DECLARE
  r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON casino_sync_runs, casino_sync_agent_ranges, casino_sync_cursors FROM %I', r
      );
      EXECUTE format(
        'REVOKE ALL ON SEQUENCE casino_sync_agent_ranges_id_seq FROM %I', r
      );
    END IF;
  END LOOP;
END;
$$;

COMMIT;

-- ============================================================
-- Rollback manual (solo si no hubo corridas nuevas que dependan de platform):
-- ver docs/runbooks/centro-monitoreo.md §Rollback. No se incluye un DOWN
-- automático porque restaurar el índice global sobre id_rec falla si ya hay
-- IDs repetidos entre plataformas, y eso hay que decidirlo a mano.
-- ============================================================
