-- ============================================================
-- Migration 108: panels_assigned — soporte multi-agente en contactos
--
-- Permite que un contacto pertenezca a más de un agente simultáneamente.
-- Ejemplo: un jugador activo en betcoin Y farabet aparece en ambas vistas
-- al filtrar por cualquiera de los dos agentes.
--
-- Diseño:
--   contacts.panel           → agente principal (se mantiene para compatibilidad)
--   contacts.panels_assigned → array de todos los agentes asignados al contacto
--
-- El filtro por agente pasa de  panel = $x  a  $x = ANY(panels_assigned).
-- ============================================================

BEGIN;

-- ── 1. Nueva columna panels_assigned ─────────────────────────────────────────
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS panels_assigned text[] NOT NULL DEFAULT '{}';

-- ── 2. Backfill: poblar desde la columna panel existente ──────────────────────
UPDATE contacts
  SET panels_assigned = ARRAY[LOWER(panel)]
  WHERE panel IS NOT NULL
    AND (panels_assigned = '{}' OR panels_assigned IS NULL);

-- ── 3. GIN index para búsquedas rápidas con = ANY() ──────────────────────────
CREATE INDEX IF NOT EXISTS idx_contacts_panels_assigned_gin
  ON contacts USING GIN (panels_assigned);

COMMIT;
