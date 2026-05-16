BEGIN;

-- ── Agrega lock_token a system_jobs para validación de ownership ──────────────
--
-- Permite que solo la instancia que adquirió el lock pueda liberarlo.
-- Sin este campo, cualquier proceso podría llamar releaseRecomputeLock y
-- liberar el lock de otra instancia (problema de seguridad con multi-instancia).
--
-- Flujo:
--   1. acquireRecomputeLock genera un UUID y lo persiste en lock_token.
--   2. releaseRecomputeLock valida AND lock_token = $1 antes de liberar.
--   3. Si el lock fue tomado por otra instancia o ya expiró+resetó, el UPDATE
--      no afecta ninguna fila → la instancia que falló no sobreescribe el state.

ALTER TABLE system_jobs
  ADD COLUMN IF NOT EXISTS lock_token UUID;

COMMENT ON COLUMN system_jobs.lock_token IS
  'UUID generado por la instancia que tomó el lock. Valida ownership en el release.';

COMMIT;
