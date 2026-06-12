-- ============================================================
-- Migration 111: Soft-delete contactos con nombres de agentes
--
-- Problema: contactos importados incorrectamente con el nombre
-- del agente como first_name (ej: "Betcoin", "Farabet", "BigWin",
-- "Royal"). Al coincidir con casino_players via JOIN por username,
-- recibían segment + last_deposit_at reales y aparecían en la
-- lista de prioridades como si fueran jugadores reales.
--
-- Solución: soft-delete (deleted_at) para que el módulo de
-- prioridades los excluya automáticamente.
-- ============================================================

UPDATE contacts
SET deleted_at = NOW(), updated_at = NOW()
WHERE LOWER(TRIM(first_name)) IN (
  'betcoin', 'farabet', 'bigwin', 'royal',
  'ofizeus', 'zeus', 'zeusroyal'
)
  AND deleted_at IS NULL;
