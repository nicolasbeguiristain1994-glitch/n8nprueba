-- Agrega line_type a whatsapp_lines para distinguir líneas Evolution (QR) de Cloud API nativas.
-- Las líneas existentes se mantienen como 'evolution' por defecto.

ALTER TABLE whatsapp_lines
  ADD COLUMN IF NOT EXISTS line_type TEXT NOT NULL DEFAULT 'evolution'
    CHECK (line_type IN ('evolution', 'cloud'));

COMMENT ON COLUMN whatsapp_lines.line_type IS
  'evolution = instancia Evolution (QR), cloud = número nativo WhatsApp Cloud API (Meta)';
