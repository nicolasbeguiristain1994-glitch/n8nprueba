-- 031_casino_transactions_timestamp.sql
--
-- Adds `fecha_hora_utc TIMESTAMPTZ` to casino_transactions so that the
-- dashboard can perform true hour-level filtering, matching Zeus semantics.
--
-- Background:
--   The Zeus API returns `fecha` as a full UTC ISO-8601 timestamp, e.g.
--   "2025-11-26T02:59:58.000Z". The original ingestion path (sync + seed)
--   discarded the time and only stored the Argentina local DATE in `fecha DATE`.
--   This made sub-day filtering impossible.
--
-- What this migration does:
--   1. Adds `fecha_hora_utc TIMESTAMPTZ NULL` — nullable so existing rows are
--      preserved without data loss.
--   2. Adds a partial index for fast timestamp-range queries on timestamped rows.
--   3. Adds a compound (agente, fecha_hora_utc) index for the main dashboard
--      filter pattern (agente + date-time range).
--
-- Backfill strategy:
--   Existing rows will have fecha_hora_utc = NULL and continue to use the
--   existing `fecha DATE` column for filtering (date-level precision).
--   Re-running seed-casino-transactions.js after this migration will backfill
--   fecha_hora_utc for existing rows via ON CONFLICT DO UPDATE.
--
-- Row-level behaviour after this migration:
--   - Rows WITH fecha_hora_utc  → filtered by exact timestamp (hour precision)
--   - Rows WITHOUT (NULL)       → filtered by fecha DATE (day precision, as before)
--
-- No existing data is modified or removed by this migration.

ALTER TABLE casino_transactions
  ADD COLUMN IF NOT EXISTS fecha_hora_utc TIMESTAMPTZ;

-- Partial index: only covers rows that actually have a timestamp (avoids
-- bloating the index with NULL entries and keeps it small/fast).
CREATE INDEX IF NOT EXISTS idx_casino_transactions_ts
  ON casino_transactions (fecha_hora_utc)
  WHERE fecha_hora_utc IS NOT NULL;

-- Compound index for the primary dashboard query: agente + timestamp range
CREATE INDEX IF NOT EXISTS idx_casino_transactions_agente_ts
  ON casino_transactions (agente, fecha_hora_utc)
  WHERE fecha_hora_utc IS NOT NULL;

COMMENT ON COLUMN casino_transactions.fecha_hora_utc IS
  'Original Zeus transaction timestamp in UTC. NULL for rows ingested before '
  'migration 031. When non-NULL, enables sub-day (hour-level) filtering. '
  'Relationship: fecha = (fecha_hora_utc AT TIME ZONE ''America/Argentina/Buenos_Aires'')::date';
