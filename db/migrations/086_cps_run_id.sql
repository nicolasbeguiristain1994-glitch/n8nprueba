BEGIN;

-- ── Consistencia de corrida: run_id en contact_priority_scores ────────────────
--
-- Problema: si un recompute falla a la mitad, la tabla queda con scores de dos
-- corridas distintas mezcladas — algunos calculados en el run actual y otros
-- que nunca fueron actualizados.
--
-- Solución: cada corrida exitosa lleva un UUID único (run_id = lock_token del
-- job). El endpoint GET /api/contacts/prioritized filtra por defecto solo los
-- contactos del último run completo (last_complete_run_id en system_jobs).
--
-- Beneficios:
--   1. La lista de difusión siempre muestra un snapshot consistente.
--   2. Si el recompute falla, los operadores siguen viendo la última buena corrida.
--   3. ?includePreviousRuns=true muestra todos los scores para debugging.

ALTER TABLE contact_priority_scores
  ADD COLUMN IF NOT EXISTS run_id UUID;

COMMENT ON COLUMN contact_priority_scores.run_id IS
  'UUID de la corrida de recompute que generó este score. NULL = corrida sin tracking (legacy).';

CREATE INDEX IF NOT EXISTS idx_cps_run_id
  ON contact_priority_scores (run_id);

COMMENT ON INDEX idx_cps_run_id IS
  'Filtro eficiente por corrida en el endpoint GET /api/contacts/prioritized.';

-- ── last_complete_run_id en system_jobs ───────────────────────────────────────
--
-- Almacena el run_id de la última corrida que completó exitosamente.
-- releaseRecomputeLock(success=true) escribe aquí su lock_token.
-- El endpoint lo usa como filtro por defecto.

ALTER TABLE system_jobs
  ADD COLUMN IF NOT EXISTS last_complete_run_id UUID;

COMMENT ON COLUMN system_jobs.last_complete_run_id IS
  'run_id de la última corrida de recompute completada exitosamente.';

COMMIT;
