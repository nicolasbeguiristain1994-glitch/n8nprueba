import { query } from '@/lib/db'
import { MetaCloudApiClient } from './client'
import { TokenExpiredError } from './errors'

// Renueva el token si vence en menos de 7 días
const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000

export interface StoredToken {
  phoneNumberId: string
  accessToken:   string
  expiresAt:     Date | null
}

// ─── Recuperar token de un número ─────────────────────────────────────────────

export async function getTokenForNumber(phoneNumberId: string): Promise<string> {
  const result = await query<{ access_token: string; token_expires_at: Date | null }>(
    `SELECT access_token, token_expires_at
     FROM cloud_numbers
     WHERE phone_number_id = $1 AND status = 'active'`,
    [phoneNumberId],
  )

  const row = result[0]
  if (!row) throw new TokenExpiredError()

  // Si el token tiene expiración y está próximo a vencer, renovar automáticamente
  if (row.token_expires_at && shouldRefresh(row.token_expires_at)) {
    return refreshToken(phoneNumberId, row.access_token)
  }

  return row.access_token
}

// ─── Persiste un token nuevo o actualizado ────────────────────────────────────

export async function storeToken(
  phoneNumberId: string,
  accessToken:   string,
  expiresAt:     Date | null,
): Promise<void> {
  await query(
    `UPDATE cloud_numbers
     SET access_token = $1, token_expires_at = $2, updated_at = NOW()
     WHERE phone_number_id = $3`,
    [accessToken, expiresAt, phoneNumberId],
  )
}

// ─── Rotación / renovación de token ──────────────────────────────────────────
// Los System User tokens de Meta no expiran, pero los tokens de usuario sí.
// Si el cliente usa un token de usuario, debemos renovar con App Secret.

async function refreshToken(phoneNumberId: string, currentToken: string): Promise<string> {
  const appId     = process.env.META_APP_ID!
  const appSecret = process.env.META_APP_SECRET!

  try {
    const { accessToken, expiresIn } = await MetaCloudApiClient.generateSystemUserToken(
      appId,
      appSecret,
      currentToken,
    )

    const expiresAt = expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000)
      : null

    await storeToken(phoneNumberId, accessToken, expiresAt)
    return accessToken
  } catch (err) {
    console.error('[token-store] Failed to refresh token for', phoneNumberId, err)
    // Retornar el token existente aunque esté próximo a vencer
    return currentToken
  }
}

function shouldRefresh(expiresAt: Date): boolean {
  return expiresAt.getTime() - Date.now() < REFRESH_THRESHOLD_MS
}

// ─── Revocar token (logout / desconexión) ────────────────────────────────────

export async function revokeToken(phoneNumberId: string): Promise<void> {
  await query(
    `UPDATE cloud_numbers
     SET status = 'suspended', access_token = '', updated_at = NOW()
     WHERE phone_number_id = $1`,
    [phoneNumberId],
  )
}

// ─── Listar todos los números activos ─────────────────────────────────────────

export async function listActiveNumbers(): Promise<StoredToken[]> {
  const result = await query<StoredToken>(
    `SELECT phone_number_id as "phoneNumberId", access_token as "accessToken", token_expires_at as "expiresAt"
     FROM cloud_numbers
     WHERE status = 'active'
     ORDER BY created_at`,
  )
  return result
}
