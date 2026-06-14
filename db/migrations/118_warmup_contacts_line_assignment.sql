-- 118_warmup_contacts_line_assignment.sql
-- ── Contactos de warmup asignados por línea ───────────────────────────────────
--
-- PROBLEMA que resuelve:
--   Antes de esta migración, todas las líneas del pool compartían el mismo
--   conjunto de contactos. El algoritmo de selección priorizaba el contacto
--   con menor `message_count`, por lo que en un pool de 30 líneas, el mismo
--   número podía recibir mensajes de 30 remitentes distintos en el mismo día.
--   Meta detecta esto como red coordinada de spam → ban masivo.
--
-- SOLUCIÓN:
--   `assigned_line_id` vincula cada contacto a una sola línea de warmup.
--   Cada línea solo envía a sus contactos asignados.
--   La lógica de auto-asignación en `/api/warmup/process` completa el pool
--   cuando una línea nueva no tiene contactos todavía.
--
-- COMPATIBILIDAD:
--   NULL = contacto sin asignar (disponible para auto-asignación).
--   Las filas existentes quedan con NULL → el proceso las va asignando
--   automáticamente en la primera ejecución de cada línea.
--   ON DELETE SET NULL: si se elimina una línea, sus contactos vuelven al pool.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE warmup_contacts
  ADD COLUMN IF NOT EXISTS assigned_line_id UUID
    REFERENCES warmup_numbers(id) ON DELETE SET NULL;

COMMENT ON COLUMN warmup_contacts.assigned_line_id IS
  'Línea de warmup propietaria de este contacto. NULL = sin asignar (pool global disponible). ON DELETE SET NULL: si se borra la línea el contacto vuelve al pool.';

-- ── Índice principal: lookup de contactos por línea ───────────────────────────
-- Usado en la query primaria de /api/warmup/process:
--   WHERE assigned_line_id = $line_id AND is_active = true
--   ORDER BY last_used_at ASC NULLS FIRST, message_count ASC
-- El orden de columnas en el índice coincide con el ORDER BY del plan de ejecución.
CREATE INDEX IF NOT EXISTS idx_warmup_contacts_line_active
  ON warmup_contacts (assigned_line_id, last_used_at ASC NULLS FIRST, message_count ASC)
  WHERE is_active = true;

-- ── Índice de fallback: contactos sin asignar (auto-asignación) ───────────────
-- Usado cuando una línea no tiene contactos propios y necesita tomar uno del pool:
--   WHERE is_active = true AND assigned_line_id IS NULL
--   ORDER BY message_count ASC
-- Partial index: solo cubre los NULL, mucho más pequeño que un índice completo.
CREATE INDEX IF NOT EXISTS idx_warmup_contacts_unassigned
  ON warmup_contacts (message_count ASC)
  WHERE is_active = true AND assigned_line_id IS NULL;

COMMIT;
