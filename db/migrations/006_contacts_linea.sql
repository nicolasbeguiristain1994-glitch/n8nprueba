-- Add linea (1-12) column to contacts
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS linea SMALLINT CHECK (linea >= 1 AND linea <= 12);
