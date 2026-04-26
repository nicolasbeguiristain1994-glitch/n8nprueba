-- 027_casino_actividad_perdido.sql
-- Adds 'perdido' to casino_players.seg_actividad allowed values.
-- 'perdido' = no movement in the last 365 days (dias_desde_ultimo > 365).
-- Computed by procesar-caja.js; stored here and propagated to contact_tags
-- as 'casino:actividad:perdido' at import time.

-- Drop the old inline CHECK constraint (auto-named by PostgreSQL)
ALTER TABLE casino_players
  DROP CONSTRAINT IF EXISTS casino_players_seg_actividad_check;

-- Re-add with 'perdido' included
ALTER TABLE casino_players
  ADD CONSTRAINT casino_players_seg_actividad_check
  CHECK (seg_actividad IN ('nuevo','frecuente','regular','ocasional','en_riesgo','inactivo','perdido'));
