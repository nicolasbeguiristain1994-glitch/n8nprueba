-- Agrega campos para rastrear el inbox de Chatwoot asociado a cada número Cloud API.

ALTER TABLE cloud_numbers
  ADD COLUMN IF NOT EXISTS chatwoot_inbox_id   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS chatwoot_inbox_name TEXT,
  ADD COLUMN IF NOT EXISTS chatwoot_created_at TIMESTAMPTZ;

COMMENT ON COLUMN cloud_numbers.chatwoot_inbox_id   IS 'ID del inbox en Chatwoot (string devuelto por la API de Chatwoot)';
COMMENT ON COLUMN cloud_numbers.chatwoot_inbox_name IS 'Nombre del inbox en Chatwoot al momento de la creación';
COMMENT ON COLUMN cloud_numbers.chatwoot_created_at IS 'Timestamp en que se creó el inbox en Chatwoot';
