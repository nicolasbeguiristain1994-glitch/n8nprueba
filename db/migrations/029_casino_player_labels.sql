-- 029_casino_player_labels.sql
-- Agrega columna labels a casino_players para etiquetas operativas por jugador.
-- Las etiquetas son texto libre asignadas por operadores desde el dashboard
-- (ej: "contactar", "bonus pendiente", "en seguimiento").
-- No reemplaza contact_tags — es un campo operativo directo sobre el jugador.

ALTER TABLE casino_players
  ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN casino_players.labels IS
  'Etiquetas operativas asignadas manualmente por el equipo desde el dashboard. '
  'Texto libre, asignadas por username de jugador.';
