-- Visibilidad por propietario en prospect_lists.
--
-- Sigue el mismo modelo que contact_lists (migración 008c y route /api/lists):
--   Admin  → ve todas las listas.
--   No admin → solo ve las listas donde owned_by = su user_id.
--
-- Por qué owned_by en lugar de reutilizar created_by:
--   created_by es un campo de auditoría (¿quién lo creó?).
--   owned_by es un campo de control de acceso (¿quién tiene visibilidad?).
--   Mantenerlos separados permite en el futuro transferir ownership sin
--   alterar el historial de creación. Este es el mismo patrón de contact_lists.
--
-- ON DELETE SET NULL: si el usuario es eliminado, la lista queda sin dueño
--   explícito y solo los admins podrán verla (igual que contact_lists trata
--   las listas con owned_by IS NULL).
--
-- panel_id está preparado para una futura visibilidad por panel (Fase 2),
--   donde los operadores de un mismo panel compartan listas. Hoy no se activa.
--   No tiene FK porque no existe tabla panels — se resolverá cuando se implemente.

ALTER TABLE prospect_lists
  ADD COLUMN IF NOT EXISTS owned_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS panel_id  UUID;

-- Poblar owned_by desde created_by para todos los registros existentes.
-- En registros donde created_by ya es NULL (usuario eliminado), owned_by
-- queda NULL: solo admins los verán, coherente con el comportamiento de contact_lists.
UPDATE prospect_lists
  SET owned_by = created_by
  WHERE owned_by IS NULL AND created_by IS NOT NULL;

-- Índice para el filtro de visibilidad en el listado.
CREATE INDEX IF NOT EXISTS idx_prospect_lists_owned_by
  ON prospect_lists(owned_by)
  WHERE owned_by IS NOT NULL;
