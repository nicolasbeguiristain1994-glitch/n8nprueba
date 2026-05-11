-- Encriptación en reposo de access_tokens de Cloud API
--
-- ESTRATEGIA DE KEY MANAGEMENT:
--   La clave de cifrado NUNCA se almacena en la base de datos.
--   Vive en Doppler como TOKEN_ENCRYPTION_KEY (AES-256, 32 bytes en hex).
--   La aplicación la pasa como parámetro a pgp_sym_encrypt/pgp_sym_decrypt.
--   Rotación de clave: re-encriptar con nueva clave usando decrypt(old)+encrypt(new)
--   en un proceso de mantenimiento, NO en una migración SQL.
--
-- PROCESO DE MIGRACIÓN:
--   1. Esta SQL agrega la columna cifrada (nullable durante transición).
--   2. La aplicación hace lazy migration: lee plaintext si enc = NULL,
--      re-encripta en el mismo UPDATE.
--   3. Después de verificar 100% enc != NULL: DROP COLUMN access_token.
--   4. NOT NULL en access_token_enc se activa con la migración 071.
--
-- ROLLBACK:
--   Si es necesario revertir, access_token sigue existiendo hasta la migración 071.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Columna cifrada: bytea porque pgp_sym_encrypt retorna bytea
ALTER TABLE cloud_numbers
  ADD COLUMN IF NOT EXISTS access_token_enc BYTEA;

-- La columna original access_token se mantiene durante la transición para rollback.
-- Se marcará como deprecated en los comentarios de código.
COMMENT ON COLUMN cloud_numbers.access_token IS
  'DEPRECATED: plaintext token — solo para rollback. Usar access_token_enc.';

COMMENT ON COLUMN cloud_numbers.access_token_enc IS
  'Token cifrado con AES-256 via pgp_sym_encrypt. Clave en Doppler: TOKEN_ENCRYPTION_KEY';

-- Índice de auditoría: qué números ya fueron migrados a cifrado
CREATE INDEX IF NOT EXISTS idx_cloud_numbers_enc_migrated
  ON cloud_numbers(id)
  WHERE access_token_enc IS NOT NULL;
