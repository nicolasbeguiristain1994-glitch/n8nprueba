-- Migration 059: Agregar columnas faltantes en warmup_numbers
--
-- display_name y evolution_url debían agregarse en migración 044, pero el
-- IF EXISTS check falló porque warmup_numbers no existía aún en producción
-- cuando 044 se ejecutó (el schema base se aplicó luego manualmente).
-- Esta migración corrige eso de forma idempotente.

ALTER TABLE warmup_numbers
  ADD COLUMN IF NOT EXISTS display_name  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS evolution_url VARCHAR(255);
