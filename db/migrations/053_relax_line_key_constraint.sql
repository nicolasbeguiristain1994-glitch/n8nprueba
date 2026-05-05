-- Migration 053: Relax line_key CHECK constraint
--
-- The original ^line_[0-3][0-9]$ pattern was designed for the initial 30-line
-- seeded setup. Production lines added via the UI (e.g. wa-01, warmup-03) don't
-- follow that pattern, causing INSERT failures. Drop the constraint so any
-- alphanumeric slug is valid.

ALTER TABLE whatsapp_lines
  DROP CONSTRAINT IF EXISTS chk_line_key_format;
