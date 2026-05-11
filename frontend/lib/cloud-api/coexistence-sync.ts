import { META_BASE_URL, type SmbSyncRequest, type SmbSyncStatus } from './types'
import { CloudApiError, fromHttpResponse } from './errors'
import { query } from '@/lib/db'
import { createLogger } from './infrastructure/logger'

const log = createLogger({ correlationId: 'system', operation: 'coexistence_sync' })

// ─── SMB App Data API ─────────────────────────────────────────────────────────
// Documentación: developers.facebook.com/docs/whatsapp/cloud-api/coexistence
//
// El flujo de Coexistence REQUIERE dos sincronizaciones obligatorias después del onboarding:
//   1. smb_app_state_sync  → sincroniza contactos de la WA Business App al Cloud API
//   2. history             → sincroniza historial de conversaciones (hasta 180 días)
//
// Ambas son asíncronas: Meta envía actualizaciones via webhooks (field 'history' y 'smb_app_state_sync')

interface SmbSyncResponse {
  success?: boolean
  id?:      string  // job ID de Meta
}

export async function triggerSmbSync(req: SmbSyncRequest, accessToken: string): Promise<SmbSyncStatus> {
  const payload: Record<string, unknown> = {
    sync_type: req.syncType,
  }

  if (req.syncType === 'history') {
    // Máximo 180 días según documentación de Meta (mayo 2026)
    const days = Math.min(req.historyDays ?? 180, 180)
    payload.date_range = {
      start: Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000),
      end:   Math.floor(Date.now() / 1000),
    }
  }

  const url = `${META_BASE_URL}/${req.wabaId}/smb_app_data`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  let body: unknown
  try { body = await res.json() } catch { body = {} }

  if (!res.ok) {
    const err = fromHttpResponse(res.status, body as Record<string, unknown>)
    await updateSyncError(req.phoneNumberId, req.syncType, err.message)
    throw err
  }

  const data = body as SmbSyncResponse

  if (data.success === false) {
    throw new CloudApiError(`La sincronización ${req.syncType} fue rechazada por Meta`)
  }

  // Registrar inicio de sync en DB
  await updateSyncState(req.phoneNumberId, req.syncType, 'in_progress')

  return {
    syncType: req.syncType,
    status:   'in_progress',
  }
}

// ─── Disparar ambas sincronizaciones en secuencia ─────────────────────────────
// Meta recomienda esperar a que smb_app_state_sync complete antes de lanzar history.
// En la práctica, ambas se pueden disparar en paralelo; usamos secuencial por seguridad.

export async function runInitialCoexistenceSync(
  wabaId:        string,
  phoneNumberId: string,
  accessToken:   string,
  historyDays:   number = 180,
): Promise<{ contacts: SmbSyncStatus; history: SmbSyncStatus }> {
  log.logInfo('starting initial sync', { phoneNumberId })

  const contacts = await triggerSmbSync(
    { wabaId, phoneNumberId, syncType: 'smb_app_state_sync' },
    accessToken,
  )

  // Esperar 2s entre sincronizaciones para evitar colisión en Meta
  await new Promise(r => setTimeout(r, 2000))

  const history = await triggerSmbSync(
    { wabaId, phoneNumberId, syncType: 'history', historyDays },
    accessToken,
  )

  return { contacts, history }
}

// ─── Procesar webhook de sync completado ──────────────────────────────────────
// Meta notifica el resultado via webhook con field 'smb_app_state_sync' o 'history'

export async function handleSyncWebhook(
  phoneNumberId: string,
  syncType:      'smb_app_state_sync' | 'history',
  status:        'completed' | 'failed',
  error?:        string,
): Promise<void> {
  await updateSyncState(phoneNumberId, syncType, status, error)

  if (status === 'completed') {
    const column = syncType === 'smb_app_state_sync' ? 'contacts_synced' : 'history_synced'
    await query(
      `UPDATE cloud_numbers SET ${column} = true, updated_at = NOW() WHERE phone_number_id = $1`,
      [phoneNumberId],
    )
    log.logInfo('sync webhook completed', { syncType, phoneNumberId })
  } else {
    log.logError('sync webhook failed', undefined, { syncType, phoneNumberId, error })
  }
}

// ─── Estado de la sincronización ─────────────────────────────────────────────

export async function getSyncStatus(phoneNumberId: string): Promise<{
  contactsSynced: boolean
  historySynced:  boolean
  syncError?:     string
}> {
  const result = await query<{
    contacts_synced: boolean
    history_synced:  boolean
    sync_error:      string | null
  }>(
    `SELECT n.contacts_synced, n.history_synced, s.sync_error
     FROM cloud_numbers n
     LEFT JOIN cloud_sync_state s ON s.phone_number_id = n.phone_number_id
     WHERE n.phone_number_id = $1`,
    [phoneNumberId],
  )

  const row = result[0]
  if (!row) throw new CloudApiError(`Número ${phoneNumberId} no encontrado`)

  return {
    contactsSynced: row.contacts_synced,
    historySynced:  row.history_synced,
    syncError:      row.sync_error ?? undefined,
  }
}

// ─── Helpers de persistencia ──────────────────────────────────────────────────

async function updateSyncState(
  phoneNumberId: string,
  syncType:      string,
  status:        string,
  error?:        string,
): Promise<void> {
  await query(
    `INSERT INTO cloud_sync_state (phone_number_id, updated_at)
     VALUES ($1, NOW())
     ON CONFLICT (phone_number_id) DO UPDATE
       SET sync_error = $2, updated_at = NOW()`,
    [phoneNumberId, status === 'failed' ? (error ?? `${syncType} failed`) : null],
  )
}

async function updateSyncError(phoneNumberId: string, syncType: string, error: string): Promise<void> {
  await query(
    `INSERT INTO cloud_sync_state (phone_number_id, sync_error, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (phone_number_id) DO UPDATE
       SET sync_error = $2, updated_at = NOW()`,
    [phoneNumberId, `[${syncType}] ${error}`],
  )
}
