-- Migration 047: Índice trigram en tasks.description para búsqueda full-text eficiente
-- Seguro de re-ejecutar (IF NOT EXISTS).
--
-- Requiere la extensión pg_trgm (disponible en todas las instancias PostgreSQL 9.6+,
-- incluyendo Supabase, RDS, Neon y Railway).  La línea CREATE EXTENSION es idempotente.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Índice GIN en title para búsquedas ILIKE rápidas (tareas activas)
CREATE INDEX IF NOT EXISTS idx_tasks_title_trgm_gin
  ON tasks USING gin (title gin_trgm_ops)
  WHERE deleted_at IS NULL;

-- Índice GIN en description para búsquedas ILIKE rápidas (tareas activas)
-- Solo indexa filas donde description NO es NULL para evitar entradas vacías.
CREATE INDEX IF NOT EXISTS idx_tasks_description_trgm
  ON tasks USING gin (description gin_trgm_ops)
  WHERE deleted_at IS NULL AND description IS NOT NULL;
