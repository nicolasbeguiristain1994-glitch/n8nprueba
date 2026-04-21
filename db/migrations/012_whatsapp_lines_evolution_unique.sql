-- Migration 012: Unique index on whatsapp_lines.evolution_instance
-- Purpose: warmup/[id]/migrate/route.ts uses SELECT-then-INSERT without a transaction.
--          Concurrent calls can race and create duplicate lines for the same instance.
--          This index makes the INSERT idempotent via ON CONFLICT DO NOTHING and
--          ensures at-most-one line per Evolution instance.
-- Note: migration 001 already defines UNIQUE on evolution_instance in its CREATE TABLE.
--       This index is a safety net in case that constraint was not applied or was dropped.

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_lines_evolution_instance_unique
  ON whatsapp_lines(evolution_instance);
