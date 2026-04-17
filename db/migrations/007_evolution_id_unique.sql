-- Fix 3: Idempotent webhook - partial unique index on evolution_message_id
-- Prevents duplicate inbound messages even if Evolution delivers the webhook twice

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_evolution_id_unique
  ON whatsapp_messages(evolution_message_id)
  WHERE evolution_message_id IS NOT NULL;
