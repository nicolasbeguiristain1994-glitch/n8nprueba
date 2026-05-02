-- Migration 041: Tabla blacklist global de exclusión
-- Evita que el sistema envíe mensajes a números que no desean recibirlos.
-- Soft-delete: removed_at/removed_by en lugar de DELETE físico.
-- Índice único sobre phone_number_normalized + removed_at IS NULL
-- para garantizar un único registro activo por número.

CREATE TABLE IF NOT EXISTS blacklist (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number_raw         TEXT        NOT NULL,
  phone_number_normalized  TEXT        NOT NULL,
  reason                   TEXT,
  source                   TEXT        NOT NULL DEFAULT 'manual'
                                       CHECK (source IN ('manual', 'automatic', 'import')),
  added_by                 UUID        REFERENCES users(id) ON DELETE SET NULL,
  added_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at               TIMESTAMPTZ,
  removed_by               UUID        REFERENCES users(id) ON DELETE SET NULL,
  campaign_id              UUID        REFERENCES campaigns(id) ON DELETE SET NULL,
  original_message         TEXT
);

-- Índice único: un número solo puede tener un registro activo (removed_at IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_blacklist_active_phone
  ON blacklist (phone_number_normalized)
  WHERE removed_at IS NULL;

-- Índice para búsquedas rápidas por número normalizado
CREATE INDEX IF NOT EXISTS idx_blacklist_phone_normalized
  ON blacklist (phone_number_normalized);

-- Índice para listar activos
CREATE INDEX IF NOT EXISTS idx_blacklist_removed_at
  ON blacklist (removed_at)
  WHERE removed_at IS NULL;

-- Índice para filtrar por source
CREATE INDEX IF NOT EXISTS idx_blacklist_source
  ON blacklist (source);
