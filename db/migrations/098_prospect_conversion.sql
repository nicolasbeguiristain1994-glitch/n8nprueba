-- Conversión de prospects a contactos.
--
-- converted_to_contact_id apunta al contacto creado al convertir.
-- Se usa ON DELETE SET NULL en lugar de RESTRICT porque si el contacto
-- se borra por razones de compliance o limpieza, no queremos que eso
-- bloquee ni corrompa el historial del prospect.
--
-- El índice parcial cubre solo filas convertidas (WHERE IS NOT NULL)
-- para que sea pequeño y útil: en la práctica la mayoría de prospects
-- nunca se convierten, y el índice solo sirve para el lookup inverso
-- "¿qué prospect originó este contacto?".

ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS converted_to_contact_id UUID
    REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_prospects_converted_to_contact_id
  ON prospects(converted_to_contact_id)
  WHERE converted_to_contact_id IS NOT NULL;

-- Ampliar el CHECK de status para incluir 'converted'.
-- La restricción original (migración 091) solo permitía 'active' y 'unsubscribed'.
-- La operación de conversión necesita poder transicionar a 'converted'.
-- Usamos DROP/ADD en lugar de ALTER porque PostgreSQL no soporta modificar
-- el predicado de un CHECK existente directamente.
-- DROP CONSTRAINT IF EXISTS es seguro: si el nombre cambió en algún entorno,
-- simplemente no hace nada y el ADD crea el nuevo constraint.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  -- Encontrar el nombre del CHECK constraint existente en la columna status
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'prospects'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%active%unsubscribed%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE prospects DROP CONSTRAINT %I', constraint_name);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prospects_status_check'
      AND conrelid = 'prospects'::regclass
  ) THEN
    ALTER TABLE prospects
      ADD CONSTRAINT prospects_status_check
      CHECK (status IN ('active', 'unsubscribed', 'converted'));
  END IF;
END
$$;

-- notes en contacts: columna nueva, no existía previamente en la tabla.
-- Se agrega aquí —junto con converted_to_contact_id— porque la funcionalidad
-- de conversión es el primer lugar donde se captura una nota libre al crear
-- un contacto desde un prospect. El campo es genérico (TEXT nullable) para
-- que también sea útil en otros flujos de creación de contactos en el futuro.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS notes TEXT;
