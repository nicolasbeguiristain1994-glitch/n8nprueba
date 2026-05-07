-- Notas internas de equipo por conversación (no visibles al cliente)
CREATE TABLE IF NOT EXISTS conversation_notes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  author_id   TEXT        NOT NULL,
  author_name TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conv_notes_phone_at
  ON conversation_notes (phone, created_at DESC);
