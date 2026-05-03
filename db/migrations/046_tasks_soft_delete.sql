-- Migration 046: Soft delete para tareas + índice de búsqueda full-text
-- Seguro de re-ejecutar (todas las operaciones son IF NOT EXISTS / IF EXISTS).

-- ── Columnas soft-delete en tasks ─────────────────────────────────────────────

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by  UUID REFERENCES users(id) ON DELETE SET NULL;

-- ── Índices de soporte ────────────────────────────────────────────────────────

-- Tareas activas (no eliminadas): consulta más frecuente
CREATE INDEX IF NOT EXISTS idx_tasks_active
  ON tasks (status, created_at DESC)
  WHERE deleted_at IS NULL;

-- Tareas eliminadas: solo para consultas admin con include_deleted=true
CREATE INDEX IF NOT EXISTS idx_tasks_deleted
  ON tasks (deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

-- Búsqueda full-text en título para la vista del operador
CREATE INDEX IF NOT EXISTS idx_tasks_title_trgm
  ON tasks (title)
  WHERE deleted_at IS NULL;
