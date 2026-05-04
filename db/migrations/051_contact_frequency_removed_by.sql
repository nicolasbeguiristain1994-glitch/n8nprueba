-- Migration 051: Agregar removed_by a contact_frequency_rules
--
-- Corrige la omisión de la migración 050: deactivate() aceptaba un parámetro
-- removed_by pero no lo persistía en DB porque la columna no existía.
--
-- Additive: ADD COLUMN IF NOT EXISTS. Idempotente.

ALTER TABLE contact_frequency_rules
  ADD COLUMN IF NOT EXISTS removed_by UUID REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN contact_frequency_rules.removed_by IS
  'Usuario que desactivó la regla (is_active = false). '
  'NULL si fue desactivada por el sistema o si aún está activa.';
