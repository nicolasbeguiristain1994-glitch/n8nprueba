-- Migration 037: Extender límite de linea de 12 a 100
-- Permite asignar contactos a hasta 100 líneas de WhatsApp.

ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS contacts_linea_check;

ALTER TABLE contacts
  ADD CONSTRAINT contacts_linea_check CHECK (linea >= 1 AND linea <= 100);
