-- ============================================================
-- Migration 123: casino_players.platform
--
-- El soporte multi-plataforma se implementó en el código de los conectores
-- (BaseCasinoConnector.upsertPlayers escribe la columna `platform`) pero nunca
-- se creó la columna en la base. Resultado: TODA sincronización fallaba con
--   column "platform" of relation "casino_players" does not exist
-- para todos los agentes, mientras el runner terminaba con "Sync run complete"
-- y exit code 0. El fallo era invisible y los datos del casino quedaron
-- congelados (última carga registrada: 2026-06-10).
--
-- La columna es nullable a propósito: las filas históricas se cargaron antes de
-- que existiera el concepto de plataforma y no hay forma confiable de inferir a
-- cuál pertenecen. El upsert ya contempla ese caso:
--   platform = COALESCE(EXCLUDED.platform, casino_players.platform)
-- ============================================================

BEGIN;

ALTER TABLE casino_players
  ADD COLUMN IF NOT EXISTS platform text;

CREATE INDEX IF NOT EXISTS idx_casino_players_platform
  ON casino_players (platform)
  WHERE platform IS NOT NULL;

COMMIT;
