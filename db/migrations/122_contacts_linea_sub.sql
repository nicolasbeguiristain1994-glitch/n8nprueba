-- Migration 122: Sub-variante de línea (a/b/c) en contacts
-- Permite diferenciar una misma línea en variantes: ej. "Línea 9 a", "Línea 9 b".
-- Es opcional y solo válida cuando el contacto ya tiene una línea asignada.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS linea_sub CHAR(1);

ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS contacts_linea_sub_check;

ALTER TABLE contacts
  ADD CONSTRAINT contacts_linea_sub_check
    CHECK (linea_sub IS NULL OR (linea IS NOT NULL AND linea_sub IN ('a', 'b', 'c')));
