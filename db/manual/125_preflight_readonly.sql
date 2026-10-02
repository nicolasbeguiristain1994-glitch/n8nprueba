-- ============================================================
-- 125_preflight_readonly.sql — SOLO LECTURA
-- ============================================================
-- Correr ANTES de aplicar db/migrations/125_casino_sync_monitoring.sql.
-- Toda la sesión es READ ONLY: cualquier escritura accidental falla.
-- Guardar la salida completa junto al ticket de aplicación.
--
-- Uso (desde una terminal con acceso aprobado a la base correcta):
--   psql "$URL" -v ON_ERROR_STOP=1 -f db/manual/125_preflight_readonly.sql
-- ============================================================

BEGIN TRANSACTION READ ONLY;

-- ── 0. ¿Ya está aplicada? ────────────────────────────────────────────────────
SELECT
  EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'casino_transactions'::regclass
      AND attname = 'platform' AND NOT attisdropped
  )                                         AS tx_platform_existe,
  to_regclass('casino_sync_runs')         IS NOT NULL AS runs_existe,
  to_regclass('casino_sync_agent_ranges') IS NOT NULL AS ranges_existe,
  to_regclass('casino_sync_cursors')      IS NOT NULL AS cursors_existe;

-- ── 1. Índices actuales de casino_transactions ──────────────────────────────
-- Deben aparecer idx_casino_transactions_id_rec e idx_casino_transactions_dedup
-- (los que la migración reemplaza).
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'casino_transactions'
  AND schemaname = (SELECT n.nspname FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.oid = 'casino_transactions'::regclass)
ORDER BY indexname;

-- ── 2. Tamaño (estimar duración de CREATE INDEX) ────────────────────────────
SELECT
  (SELECT reltuples::bigint FROM pg_class WHERE oid = 'casino_transactions'::regclass) AS filas_estimadas,
  pg_size_pretty(pg_total_relation_size('casino_transactions'))                       AS tamano_total;

-- ── 3. Clasificación que haría el backfill manual, por agente ────────────────
-- ZEUS_ONLY / BET30_ONLY: candidatos al backfill (125_backfill_platform_inequivocos.sql).
-- AMBIGUO (bigwin): existe en las dos plataformas — NO se clasifica automáticamente.
-- SIN_MAPEO: agente desconocido — revisar a mano.
SELECT
  agente,
  CASE
    WHEN LOWER(agente) IN ('betcoin', 'ofizeus', 'royal', 'farabet', 'lasvegas') THEN 'ZEUS_ONLY'
    WHEN LOWER(agente) IN ('btcuno', 'btcdos', 'zeus', 'zeusroyal')              THEN 'BET30_ONLY'
    WHEN LOWER(agente) = 'bigwin'                                               THEN 'AMBIGUO'
    ELSE 'SIN_MAPEO'
  END                                          AS clasificacion,
  COUNT(*)                                     AS filas,
  COUNT(*) FILTER (WHERE id_rec IS NULL)       AS filas_sin_id,
  MIN(fecha)                                   AS desde,
  MAX(fecha)                                   AS hasta,
  COUNT(*) FILTER (WHERE fecha_hora_utc IS NULL) AS filas_sin_hora
FROM casino_transactions ct
-- to_jsonb funciona tanto antes como después de que exista la columna platform.
-- El backfill solo modifica candidatos sin plataforma.
WHERE to_jsonb(ct)->>'platform' IS NULL
GROUP BY agente
ORDER BY clasificacion, filas DESC;

-- ── 4. IDs sospechosos ──────────────────────────────────────────────────────
-- El conector trata id_rec <= 0 como "sin ID" (va a la dedup por día).
SELECT
  COUNT(*) FILTER (WHERE id_rec = 0) AS id_rec_cero,
  COUNT(*) FILTER (WHERE id_rec < 0) AS id_rec_negativo,
  COUNT(*) FILTER (WHERE id_rec IS NULL) AS id_rec_null
FROM casino_transactions;

-- ── 5. Usuarios con distinta capitalización ─────────────────────────────────
-- casino_players es único por LOWER(username); estos jugadores ya se agregan juntos.
SELECT LOWER(username) AS username_lower,
       COUNT(DISTINCT username) AS variantes,
       array_agg(DISTINCT username) AS ejemplos
FROM casino_transactions
GROUP BY LOWER(username)
HAVING COUNT(DISTINCT username) > 1
ORDER BY variantes DESC
LIMIT 50;

-- ── 6. Colisiones que harían fallar el backfill ─────────────────────────────
-- Considera juntos candidatos y filas ya clasificadas en su plataforma destino.
-- Excluye conflictos entre plataformas distintas o agentes sin mapeo. Todas las
-- filas reportadas requieren revisión antes de ejecutar el backfill.
WITH destinos AS (
  SELECT ct.*, to_jsonb(ct)->>'platform' AS plataforma_actual,
         COALESCE(to_jsonb(ct)->>'platform', CASE
           WHEN LOWER(agente) IN ('betcoin','ofizeus','royal','farabet','lasvegas') THEN 'zeus'
           WHEN LOWER(agente) IN ('btcuno','btcdos','zeus','zeusroyal') THEN 'bet30'
         END) AS plataforma_destino
  FROM casino_transactions ct
)
SELECT plataforma_destino, id_rec, COUNT(*) AS filas,
       COUNT(*) FILTER (WHERE plataforma_actual IS NULL) AS candidatos
FROM destinos
WHERE id_rec IS NOT NULL AND plataforma_destino IS NOT NULL
GROUP BY plataforma_destino, id_rec
HAVING COUNT(*) > 1 AND BOOL_OR(plataforma_actual IS NULL)
ORDER BY filas DESC
LIMIT 50;

WITH destinos AS (
  SELECT ct.*, to_jsonb(ct)->>'platform' AS plataforma_actual,
         COALESCE(to_jsonb(ct)->>'platform', CASE
           WHEN LOWER(agente) IN ('betcoin','ofizeus','royal','farabet','lasvegas') THEN 'zeus'
           WHEN LOWER(agente) IN ('btcuno','btcdos','zeus','zeusroyal') THEN 'bet30'
         END) AS plataforma_destino
  FROM casino_transactions ct
)
SELECT plataforma_destino, agente, fecha, LOWER(username) AS username_lower,
       tipo, monto, COUNT(*) AS filas,
       COUNT(*) FILTER (WHERE plataforma_actual IS NULL) AS candidatos
FROM destinos
WHERE id_rec IS NULL AND plataforma_destino IS NOT NULL
GROUP BY plataforma_destino, agente, fecha, LOWER(username), tipo, monto
HAVING COUNT(*) > 1 AND BOOL_OR(plataforma_actual IS NULL)
ORDER BY filas DESC
LIMIT 50;

-- ── 7. Deriva actual casino_players vs casino_transactions ──────────────────
-- Misma semántica que el recompute nuevo: por LOWER(username), todos los agentes
-- y plataformas, excluyendo filas donde username = agente.
WITH fuente AS (
  SELECT LOWER(username) AS uname,
         COALESCE(SUM(monto) FILTER (WHERE tipo = 'carga'),  0) AS total_cargas,
         COALESCE(SUM(monto) FILTER (WHERE tipo = 'retiro'), 0) AS total_retiros
  FROM casino_transactions
  WHERE LOWER(username) <> LOWER(agente)
  GROUP BY LOWER(username)
)
SELECT
  COUNT(*)                                                     AS jugadores_comparados,
  COUNT(*) FILTER (WHERE cp.total_cargas  IS DISTINCT FROM f.total_cargas)   AS con_diferencia_cargas,
  COUNT(*) FILTER (WHERE cp.total_retiros IS DISTINCT FROM f.total_retiros)  AS con_diferencia_retiros,
  SUM(cp.total_cargas  - f.total_cargas)                       AS exceso_cargas,
  SUM(cp.total_retiros - f.total_retiros)                      AS exceso_retiros
FROM casino_players cp
JOIN fuente f ON f.uname = cp.username_lower;

-- ── 8. Jugadores sin transacciones ──────────────────────────────────────────
-- El recompute solo toca jugadores con movimientos en el rango sincronizado;
-- estos quedan intactos (incluida su segmentación).
SELECT COUNT(*) AS jugadores_sin_transacciones
FROM casino_players cp
WHERE NOT EXISTS (
  SELECT 1 FROM casino_transactions ct WHERE LOWER(ct.username) = cp.username_lower
);

-- ── 9. Conexión ─────────────────────────────────────────────────────────────
-- El runner usa pg_try_advisory_lock de sesión: DATABASE_URL del runner debe
-- ser conexión directa o pooler en modo sesión (NO el pooler transaccional).
SELECT current_database(), inet_server_port() AS puerto_servidor, version();

ROLLBACK;
