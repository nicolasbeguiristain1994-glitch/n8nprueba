-- Línea fija por conversación: mapea un número de teléfono a la instancia
-- WhatsApp que debe usarse siempre para esa conversación.
-- Si la línea asignada deja de estar disponible, el sistema asigna una nueva
-- y actualiza este registro.
CREATE TABLE IF NOT EXISTS phone_line_assignments (
  phone        TEXT PRIMARY KEY,
  line_id      UUID REFERENCES whatsapp_lines(id) ON DELETE SET NULL,
  assigned_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Historial de transacciones del jugador (poblado manualmente o por importación CSV).
-- Se usa para el badge "Solo 1 depósito - 10+ días" y el filtro "Sin movimiento".
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS last_deposit_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS total_deposits    INT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_withdrawals INT  DEFAULT 0;
