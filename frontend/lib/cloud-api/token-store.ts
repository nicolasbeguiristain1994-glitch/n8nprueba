// Gestión de tokens de acceso con encriptación en reposo (AES-256 via pgcrypto).
//
// KEY MANAGEMENT:
//   TOKEN_ENCRYPTION_KEY  = secreto de 32+ chars en Doppler (nunca en código)
//   La clave NUNCA se almacena en PostgreSQL — se pasa como parámetro a pgp_sym_encrypt.
//
// ROTACIÓN DE CLAVE:
//   1. Agregar TOKEN_ENCRYPTION_KEY_NEW en Doppler.
//   2. Ejecutar: scripts/ops/rotate-token-key.ts
//      (lee con KEY_OLD, escribe con KEY_NEW — nunca hay ventana sin encriptación)
//   3. Eliminar TOKEN_ENCRYPTION_KEY_OLD de Doppler.
//
// MIGRACIÓN LAZY desde tokens en texto plano (access_token column):
//   Si access_token_enc = NULL, se lee de access_token (deprecated) y se re-encripta.
//   Esto permite cero-downtime durante la transición.

import { query } from '@/lib/db'
import { TokenExpiredError, CloudApiError } from './errors'
import { generateLongLivedToken } from './infrastructure/meta-http.gateway'
import { createLogger } from './infrastructure/logger'

const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000  // renovar si vence en < 7 días
const tokenStoreLog = createLogger({ correlationId: 'system', operation: 'token_store' })

function getEncryptionKey(): string {
  const key = process.env.TOKEN_ENCRYPTION_KEY
  if (!key || key.length < 16) {
    throw new CloudApiError(
      'TOKEN_ENCRYPTION_KEY no está configurada o es demasiado corta. Configúrala en Doppler.',
      0, 'ConfigurationError', undefined, false,
    )
  }
  return key
}

// ─── Leer token (con migración lazy desde plaintext) ──────────────────────────

export async function getTokenForNumber(phoneNumberId: string): Promise<string> {
  const encKey = getEncryptionKey()

  type Row = { token_enc: string | null; token_plain: string | null; expires_at: Date | null }
  const rows = await query<Row>(
    `SELECT
       CASE WHEN access_token_enc IS NOT NULL
            THEN pgp_sym_decrypt(access_token_enc, $1)::text
            ELSE NULL
       END AS token_enc,
       CASE WHEN access_token_enc IS NULL THEN access_token ELSE NULL END AS token_plain,
       token_expires_at AS expires_at
     FROM cloud_numbers
     WHERE phone_number_id = $2 AND status = 'active'`,
    [encKey, phoneNumberId],
  )

  const row = rows[0]
  if (!row) throw new TokenExpiredError()

  const token = row.token_enc ?? row.token_plain

  if (!token) throw new TokenExpiredError()

  // Migración lazy: si vino de plaintext, encriptar ahora
  if (row.token_plain && !row.token_enc) {
    void migrateToEncrypted(phoneNumberId, token, encKey)
  }

  // Renovar si vence pronto
  if (row.expires_at && shouldRefresh(row.expires_at)) {
    return refreshToken(phoneNumberId, token, encKey)
  }

  return token
}

// ─── Persistir token encriptado ───────────────────────────────────────────────

export async function storeToken(
  phoneNumberId: string,
  plainToken:    string,
  expiresAt:     Date | null,
): Promise<void> {
  const encKey = getEncryptionKey()
  await query(
    `UPDATE cloud_numbers
     SET access_token_enc   = pgp_sym_encrypt($1, $2),
         access_token       = '',          -- limpia el plaintext
         token_expires_at   = $3,
         updated_at         = NOW()
     WHERE phone_number_id = $4`,
    [plainToken, encKey, expiresAt, phoneNumberId],
  )
}

// ─── Revocar token ────────────────────────────────────────────────────────────

export async function revokeToken(phoneNumberId: string): Promise<void> {
  await query(
    `UPDATE cloud_numbers
     SET status            = 'suspended',
         access_token_enc  = NULL,
         access_token      = '',
         updated_at        = NOW()
     WHERE phone_number_id = $1`,
    [phoneNumberId],
  )
}

// ─── Listar números activos ───────────────────────────────────────────────────

export interface StoredToken {
  phoneNumberId: string
  expiresAt:     Date | null
}

export async function listActiveNumbers(): Promise<StoredToken[]> {
  const rows = await query<StoredToken>(
    `SELECT phone_number_id AS "phoneNumberId", token_expires_at AS "expiresAt"
     FROM cloud_numbers WHERE status = 'active' ORDER BY created_at`,
  )
  return rows
}

// ─── Helpers privados ─────────────────────────────────────────────────────────

async function migrateToEncrypted(
  phoneNumberId: string,
  plainToken:    string,
  encKey:        string,
): Promise<void> {
  try {
    await query(
      `UPDATE cloud_numbers
       SET access_token_enc = pgp_sym_encrypt($1, $2), access_token = '', updated_at = NOW()
       WHERE phone_number_id = $3`,
      [plainToken, encKey, phoneNumberId],
    )
    tokenStoreLog.logInfo('lazy migration completed', { phoneNumberId })
  } catch (err) {
    tokenStoreLog.logError('lazy migration failed', err, { phoneNumberId })
  }
}

async function refreshToken(
  phoneNumberId: string,
  currentToken:  string,
  encKey:        string,
): Promise<string> {
  const appId     = process.env.META_APP_ID
  const appSecret = process.env.META_APP_SECRET
  if (!appId || !appSecret) return currentToken

  try {
    const { accessToken, expiresIn } = await generateLongLivedToken(appId, appSecret, currentToken)
    const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null

    await query(
      `UPDATE cloud_numbers
       SET access_token_enc = pgp_sym_encrypt($1, $2), access_token = '', token_expires_at = $3, updated_at = NOW()
       WHERE phone_number_id = $4`,
      [accessToken, encKey, expiresAt, phoneNumberId],
    )
    return accessToken
  } catch (err) {
    tokenStoreLog.logWarn('token refresh failed', { phoneNumberId, error: String(err) })
    return currentToken
  }
}

function shouldRefresh(expiresAt: Date): boolean {
  return expiresAt.getTime() - Date.now() < REFRESH_THRESHOLD_MS
}
