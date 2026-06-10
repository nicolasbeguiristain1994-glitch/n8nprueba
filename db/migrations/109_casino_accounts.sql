-- ============================================================
-- Migration 109: casino_accounts — múltiples usuarios de casino por contacto
--
-- Un mismo número de teléfono puede tener distintos nombres de usuario
-- en distintos agentes (ej: mati28z en farabet y mati228z en betcoin).
-- Esta columna guarda todos los pares {panel, username} conocidos.
--
-- Estructura: [{"panel": "farabet", "username": "mati28z"}, ...]
-- ============================================================

BEGIN;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS casino_accounts jsonb NOT NULL DEFAULT '[]';

-- Backfill: si first_name parece un username de casino (no es un nombre normal)
-- y panel está asignado, lo registramos como cuenta conocida.
UPDATE contacts
  SET casino_accounts = jsonb_build_array(
    jsonb_build_object('panel', LOWER(panel), 'username', first_name)
  )
  WHERE panel IS NOT NULL
    AND first_name IS NOT NULL
    AND casino_accounts = '[]';

COMMIT;
