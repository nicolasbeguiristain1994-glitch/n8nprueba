-- Migration 035: Visibilidad de contactos por operador (multi-tenancy ligero)
--
-- Un admin puede asignar explícitamente qué contactos puede ver cada operador.
-- Si un operador no tiene filas en esta tabla → ve cero contactos.
-- Admin siempre bypasea esta tabla (ve todo).
--
-- Relación M:N porque un contacto puede ser visible para múltiples operadores.

CREATE TABLE IF NOT EXISTS operator_contact_visibility (
  operator_id  UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  contact_id   UUID        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  assigned_by  UUID                 REFERENCES users(id)    ON DELETE SET NULL,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (operator_id, contact_id)
);

-- Búsqueda eficiente de "todos los contactos visibles para el operador X"
CREATE INDEX IF NOT EXISTS idx_ocv_operator ON operator_contact_visibility (operator_id);

-- Búsqueda eficiente de "qué operadores pueden ver el contacto Y"
CREATE INDEX IF NOT EXISTS idx_ocv_contact  ON operator_contact_visibility (contact_id);

-- assigned_by para auditoría
CREATE INDEX IF NOT EXISTS idx_ocv_assigned_by ON operator_contact_visibility (assigned_by);

COMMENT ON TABLE operator_contact_visibility IS
  'Visibilidad explícita de contactos por operador. Solo admin puede gestionar estas filas. Operadores sin filas asignadas ven 0 contactos.';
